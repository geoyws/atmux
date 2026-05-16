// CAPSTONE e2e — pre-sopx team-of-teams gate (Task t-edc93b42, Phase-1 skeleton).
//
// **Phase-1 STATUS: SKELETON ONLY.** Authored against trunk @ 4312bc2,
// which does NOT yet carry the ADR-090 / ADR-091 / ADR-092 surfaces this
// spec exercises. All sub-tests are `test.todo` placeholders cross-
// linked to **Task t-bc4fdb19** (phase-2) which wires the real assertions
// once the fan-ins land:
//
//   | Surface                                              | Commit   | Branch              |
//   |------------------------------------------------------|----------|---------------------|
//   | ADR-090 TeamEpic + KanbanEpic + epic-rosters/default | 762716f  | geoyws-up-impl-3    |
//   | ADR-090 spawn-epic + dissolve-epic verbs             | aac4ee1  | geoyws-up-impl-3    |
//   | ADR-091 epic-merge state machine + cron + gitter     | a34fafa  | geoyws-up-impl-3    |
//   | ADR-090↔091 wire-up (dissolveEpic on merging→merged) | b502ebe  | geoyws-up-impl-3    |
//   | ADR-092 cross-team tell-lead --team flag             | ba7ee3f  | geoyws-up-impl      |
//
// The skeleton intentionally ships now (vs deferring) to:
//   (1) reserve the canonical filename + fixture shape so phase-2's diff
//       is implementation-only;
//   (2) document the INTENDED lifecycle + state-snapshot expectations
//       per the CLAUDE.md Test finding report pattern (state-snapshot at
//       each step / containment analysis / fix sketch / residue inventory
//       / severity-with-context); and
//   (3) lock down the helper signatures (`makeFixture`, `seedEpicKanban`,
//       `snapshotLifecycleState`, `assertNoLeakage`) so phase-2's review
//       gate has a stable structural contract.
//
// Per ADR-029 §F1 "stateful e2e specs are not repeatable smokes" — the
// real phase-2 will be a 1x cold-start+walk integration test, not a
// streak-runnable stability smoke; seed-consumption is intrinsic.
//
// **Out of scope this skeleton + phase-2 entirely** (per Task body
// §Out of scope): sopx-side migration (operator-driven), PR-mode
// dissolution (resolved-open #5), member-to-member cross-team messaging.

import { afterAll, describe, test } from "bun:test";

// Module-level fixture-survivor registry mirrors the t-88b60ca7 /
// c-4698c603 defense pattern shipped in tests/unit/verbs/cockpit.test.ts.
// Even though every test in this file is `test.todo` at phase-1, the
// registry + afterAll hook are wired now so the same defensive
// machinery lights up automatically when phase-2 swaps in real
// fixtures.
const activeFixtureDirs = new Set<string>();
let fixtureExitHookRegistered = false;

function tearDownFixtureSurvivors(): void {
  for (const dir of activeFixtureDirs) {
    try {
      // Synchronous rm — exit handlers can't await. Phase-2 will
      // augment with `Bun.spawnSync(["tmux", "-S", <sock>, "kill-server"])`
      // for any spawned cage tmux sockets per the spawn-epic auto-launch
      // path (ADR-090).
      require("node:fs").rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  activeFixtureDirs.clear();
}

function registerFixtureExitHook(): void {
  if (fixtureExitHookRegistered) return;
  fixtureExitHookRegistered = true;
  process.on("exit", tearDownFixtureSurvivors);
}

afterAll(() => {
  tearDownFixtureSurvivors();
});

// =========================================================================
// FIXTURE HELPER SIGNATURES (phase-2 wires impls; signatures locked here)
// =========================================================================

/** Cold-start a fresh parent atmux-team fixture: bare remote +
 *  working clone + parent `team.json` with `epicTeam.enabled = true`
 *  + `autoMerge.enabled = true` (ADR-091 §schema) + roster preset for
 *  epic-lead spawn (ADR-090 §epic-rosters/default).
 *
 *  Phase-2: import {provisionWorktree} from "../../src/abstractions/worktree.ts"
 *  + mirror the bare-remote + initial-develop-commit shape from
 *  `tests/e2e/merger-fan-in.test.ts:makeFixture` (lines ~60-115).
 *  Register `tmpRoot` into `activeFixtureDirs` before returning. */
interface ParentFixture {
  readonly tmpRoot: string;
  readonly bareRemotePath: string;
  readonly repoPath: string;
  readonly atmuxDir: string;
  /** Parent team name; canonical for these tests is `"atmux-test-parent"`. */
  readonly parentName: string;
}

// declare const makeParentFixture: () => Promise<ParentFixture>;

/** Drive `atmux team spawn-epic --from <parent> --epic-name <name>
 *  --roster epic-default` against the parent fixture. Asserts:
 *  (a) `<parent>/.atmux/team.json` updated with new epic entry; (b)
 *  `<root>/.atmux/cockpit.json` (or test-injected cockpit config) gains
 *  an `EpicTeamSession` entry with `type='epic-team' parent=<parent>
 *  epicId=e-XXXXXXXX`; (c) parent kanban gains a `KanbanEpic` row in
 *  `planning` state per ADR-007 lifecycle; (d) epic-team cage tmux
 *  socket bound under `<atmuxDir>/.atmux/epic-<name>/tmux/`; (e) epic-
 *  lead pane spawned with the epic-default roster brief.
 *
 *  Phase-2: import `spawnEpic` from `../../src/verbs/team/spawn-epic.ts`
 *  (lands via aac4ee1 once fan-in clears) + invoke programmatically with
 *  a test logger; the verb itself owns the worktree + cockpit + kanban
 *  + tmux-socket setup. */
interface SpawnedEpic {
  readonly epicName: string;
  readonly epicId: string;
  readonly epicAtmuxDir: string;
  readonly epicTmuxSocket: string;
}

// declare const spawnEpicAgainstParent: (
//   parent: ParentFixture,
//   epicName: string,
// ) => Promise<SpawnedEpic>;

/** Snapshot the lifecycle state across parent + epic at one moment.
 *  Phase-2 captures: parent `KanbanEpic.status`, every `KanbanTask` in
 *  the epic's kanban (id/status/owner), cockpit tree shape (parent +
 *  epic-team entries), worktree presence (`<parent-root>/.atmux/
 *  epic-<name>/`), cage tmux session liveness, cron block presence
 *  (`atmux:team=<parent>-epic-<name>`).
 *
 *  Per CLAUDE.md Test finding report pattern: state-snapshot at each
 *  step, not just end-state. */
interface LifecycleSnapshot {
  readonly stage: string;
  readonly parentEpicStatus: string | null;
  readonly epicTasks: ReadonlyArray<{ id: string; status: string; owner: string | null }>;
  readonly cockpitEpicEntry: { type: string; parent: string; epicId: string } | null;
  readonly worktreePresent: boolean;
  readonly cageSessionAlive: boolean;
  readonly cronBlockPresent: boolean;
}

// declare const snapshotLifecycleState: (
//   parent: ParentFixture,
//   epic: SpawnedEpic,
//   stage: string,
// ) => Promise<LifecycleSnapshot>;

/** Drive `atmux team dissolve-epic --epic <name> --soft` against an
 *  epic. Asserts: (a) soft-stop path fires (notice → grace → resume
 *  manifest write at `<epicAtmuxDir>/state/resume.json` with
 *  `reason='dissolve-epic'`); (b) per-member-branches fan in to epic-
 *  team trunk (ADR-091 epic-merge state machine, states
 *  `recording → merging → merged`); (c) epic-team trunk fans in to
 *  parent trunk; (d) worktree pruned (`<parent-root>/.atmux/
 *  epic-<name>/` absent); (e) cockpit entry removed from
 *  `cockpit.sessions[]`; (f) parent KanbanEpic row transitions to
 *  `done`; (g) cron block removed (no stale `atmux:team=<parent>-
 *  epic-<name>` between `>>>` / `<<<` markers in user crontab).
 *
 *  Phase-2: import `dissolveEpic` from `../../src/verbs/team/dissolve-
 *  epic.ts` (lands via aac4ee1) + invoke programmatically. The
 *  `--soft` path is the canonical dissolution mode per ADR-090; the
 *  hard/force path is deferred per body §Out of scope. */
interface DissolutionResult {
  readonly finalSnapshot: LifecycleSnapshot;
  readonly mergedShas: ReadonlyArray<string>;
}

// declare const dissolveEpicAgainstParent: (
//   parent: ParentFixture,
//   epic: SpawnedEpic,
// ) => Promise<DissolutionResult>;

/** Final-state assertion: no leaked tmpdirs, sockets, or cron blocks.
 *  Phase-2 walks `os.tmpdir()` for any `atmux-e2e-team-of-teams-…`
 *  dirs + `/tmp/atmux-<parent>-epic-<X>/sock` paths + greps user crontab
 *  for un-bracketed `atmux:team=<parent>-epic-<X>` lines. */
// declare const assertNoLeakage: (parent: ParentFixture) => Promise<void>;

// =========================================================================
// LIFECYCLE WALK — described inline, asserted in phase-2 (t-bc4fdb19)
// =========================================================================

describe.skip("team-of-teams pre-sopx capstone (phase-1 skeleton)", () => {
  // Documented walk — each test.todo carries a no-op fn body at phase-1
  // (TS signature requires it). Phase-2 swaps the body for real claim
  // → done → snapshot → assert wiring against the helper signatures
  // locked above.

  test.todo("🌱 spawn 2 throwaway epics in parallel under one parent fixture", () => {
    // Acceptance for t-bc4fdb19:
    //   - Both epics returned with distinct epicId (e-XXXXXXXX).
    //   - Parent cockpit has 2 EpicTeamSession entries; parent kanban
    //     has 2 KanbanEpic rows in `planning` status.
    //   - Per-epic atmuxDir + tmux socket exist + are isolated from
    //     each other (no shared tmpdir paths).
    //   - Snapshot: stage="post-spawn-parallel".
  });

  test.todo("📝 seed 2 mock Tasks in each epic's kanban (4 total across 2 epics)", () => {
    // Per-epic seeded Tasks: one `lane=fe` + one `lane=be` so the
    // per-member-branch fan-in path exercises both lanes through the
    // epic's gitter. Tasks reference the parent kanban's Epic row via
    // `task.epic = <epicId>`.
    // Snapshot: stage="post-seed".
  });

  test.todo("🏗️ walk each epic's task lifecycle: file → claim → SHA → done", () => {
    // Programmatic walk per task: claim via `atmux claim <id> --as
    // <member>` against the epic's state.db; member commits 1 file
    // on their `<epic-trunk>-<member>` branch; mark done via `atmux
    // done <id> --as <member> --note "feat(scope): ..."`. Run BOTH
    // epics' walks in parallel via `Promise.all` to certify isolation.
    // Snapshot: stage="post-task-done-per-epic" (2 snapshots, 1 per epic).
  });

  test.todo("🔄 auto-merge state machine: per-member branches fan into epic-trunk", () => {
    // Trigger via `atmux gitter --sweep` against each epic's atmuxDir.
    // ADR-091 state machine walks `recording → merging → merged` per
    // member branch. Both epics' fan-ins run in parallel (separate
    // gitter dispatchers per epic; verify no cross-talk via cockpit
    // tree's session boundaries).
    // Snapshot: stage="post-epic-trunk-fan-in" (2 snapshots).
  });

  test.todo("🔄 auto-merge state machine: epic-trunk fans into parent trunk", () => {
    // After per-member fan-in lands on epic-trunk, dissolveEpic
    // (next test) triggers the epic-trunk → parent-trunk merge per
    // ADR-091's wire-up commit (b502ebe). Hold this snapshot until
    // post-dissolution to capture the parent's `git log --oneline
    // --merges` showing 2 merge commits (one per epic).
    // Snapshot: stage="post-parent-trunk-merge" (1 snapshot, both epics).
  });

  test.todo("🧹 dissolve-epic per epic — soft-stop + worktree prune + cockpit unregister", () => {
    // Per-epic `atmux team dissolve-epic --epic <name> --soft`.
    // Asserts soft-stop emits `reason='dissolve-epic'` resume manifest;
    // worktree pruned; cockpit `sessions[]` no longer carries the
    // epic; cron block removed; epic state.db archived per groom-
    // archive sub-op.
    // Snapshot: stage="post-dissolution" (2 snapshots).
  });

  test.todo("✅ parent KanbanEpic rows for BOTH epics transition to done", () => {
    // Verify `kanban.epics[].status === 'done'` for both spawned
    // epicIds + `completedAt` populated. ADR-090↔091 wire-up
    // (b502ebe) is the closure path here.
  });

  test.todo("🧪 no-leakage final assertion — tmpdirs, sockets, cron blocks all clean", () => {
    // `assertNoLeakage` walks os.tmpdir() / /tmp/atmux-… / `crontab -l`
    // for any residue. The afterAll hook is the safety net; this
    // assertion proves the happy-path cleanup is already complete
    // before the hook fires.
    // Snapshot: stage="post-cleanup" + diff against baseline taken
    // pre-spawn (every set difference must be empty).
  });
});

// =========================================================================
// TODO BLOCK — phase-2 (t-bc4fdb19) cross-team + doctor surfaces
// =========================================================================
//
// The lifecycle walk above does NOT exercise the following surfaces;
// they're scoped explicitly to phase-2 (t-bc4fdb19) per the lead's
// (C) greenlight + the WIDER blocker finding documented in the spec
// header. Phase-2 wires them once geoyws-up-impl-3 + geoyws-up-impl
// fan into trunk via gitter (currently queued; gitter-stuck-bug
// captured separately at t-f4088323).
//
//   ① cross-team tell-lead, 3 paths (ADR-092 ba7ee3f):
//      - parent driver → epic-lead happy path
//      - epic-lead → parent happy path
//      - unrelated-team caller-scope refusal (cockpit-walk no-match)
//      Helper:  exec(`atmux tell-lead --team <epic> "<msg>"`) + read
//               driver-inbox.md mtime + nudge-pane capture.
//
//   ② doctor checks (t-c2e544b6 deliverable):
//      - D5a — submodule pointer integrity (epic-team submodule under
//              parent worktree). Existing ADR-057 §D5a check extended
//              for epic-team awareness.
//      - D8  — `epicTeam.parent` reachability. Parent must exist in
//              cockpit; parent's kanban must carry the corresponding
//              KanbanEpic row. Orphaned epic-team (parent removed)
//              surfaces as P1 doctor row.
//      - D9  — prefix-level consistency. Every cage tmux.conf prefix
//              must match its `ATMUX_NESTING_LEVEL` env (ADR-089).
//      Helper: import `runDoctor` from `../../src/verbs/doctor.ts` +
//              build a corrupted cockpit fixture per check.
//
//   ③ Adjacent-to-adjacent flags from t-cc4c5fd9 audit (Task body §🔎):
//      - gh-CLI auth-switch race under pr-mode (skip for auto-mode
//        capstone; phase-2 documents the carve-out only).
//      - Claude API rate-limit ceiling under 2 epics × 7 members = 14
//        simultaneous TUIs (cross-correlate with t-77ae2baa Class 3
//        stress test).
//      - GitHub Actions cross-account secret scoping (pr-mode only;
//        capstone is auto-mode, skip).
//
// Phase-2 acceptance gate stays identical to phase-1 + adds:
//   - [ ] All 3 cross-team tell-lead paths assert correct routing.
//   - [ ] D5a/D8/D9 detect corruption + return correct severity.
//   - [ ] Coverage on `src/verbs/team/spawn-epic.ts` +
//         `src/verbs/team/dissolve-epic.ts` reaches 100% line + func.
//
// =========================================================================
// RUNBOOK CROSS-REF
// =========================================================================
//
// `docs/RUNBOOK-team-of-teams.md` is the operator-facing companion to
// this spec. Per CLAUDE.md "Pair demo runbook beats with rehearsal
// spec steps": every runbook beat name = one `test.step()` label
// verbatim in phase-2. Drift surfaces as a failing rehearsal run,
// not a sopx-flip-morning surprise.
