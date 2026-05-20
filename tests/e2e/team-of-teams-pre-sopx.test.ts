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

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { defaultGitSpawn } from "../../src/abstractions/worktree.ts";
import { ConfigError } from "../../src/errors.ts";
import { spawnEpic } from "../../src/verbs/team/spawn-epic.ts";
import { tellLead } from "../../src/verbs/tell-lead.ts";

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
// PHASE-2 IMPLEMENTATIONS (t-bc4fdb19) — ADR-092 cross-team tell-lead
// =========================================================================
//
// Three INTEGRATION-shaped tests exercise the ADR-092 verb surface
// against real cockpit fixtures + spawn-epic verb. Tmux-send failure
// in the test process (no real cage server) is the EXPECTED terminal
// failure mode; assertion uses the durable inbox-write that lands
// BEFORE the tmux send (per ADR-029 §F6 + F7 + the tell-lead.ts
// "appendDriverInbox already landed before this throw" comment).
//
// Helper signatures locked in phase-1 (ParentFixture, SpawnedEpic) are
// implemented here. The lifecycle walk `describe.skip` above remains
// at phase-1 scope — those 8 stages (spawn-parallel → seed → walk →
// epic-trunk fan-in → parent-trunk merge → dissolve → KanbanEpic done →
// no-leakage) are a separate scope-class from the ADR-092 cross-team
// surfaces; phase-2's Task body explicitly scoped only the cross-team
// + doctor (latter still deferred to t-c2e544b6).

async function git(
  cwd: string,
  argv: ReadonlyArray<string>,
  allowNonZero = false,
): Promise<string> {
  const r = await defaultGitSpawn(["-C", cwd, ...argv]);
  if (!allowNonZero && r.exitCode !== 0) {
    throw new Error(`git ${argv.join(" ")} (cwd=${cwd}) exit=${r.exitCode}\nstderr:\n${r.stderr}`);
  }
  return r.stdout.trim();
}

interface ParentFixtureRuntime extends ParentFixture {
  readonly bareRemotePath: string;
  readonly cockpitPath: string;
  readonly templatesDir: string;
  readonly capturedLogs: string[];
}

async function makeParentFixture(): Promise<ParentFixtureRuntime> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "atmux-e2e-team-of-teams-"));
  activeFixtureDirs.add(tmpRoot);
  registerFixtureExitHook();
  const bareRemotePath = join(tmpRoot, "origin.git");
  const parentRoot = join(tmpRoot, "atmux-test-parent");
  const cockpitPath = join(tmpRoot, "cockpit.json");
  const templatesDir = join(tmpRoot, "templates", "epic-rosters");

  await mkdir(bareRemotePath, { recursive: true });
  await git(bareRemotePath, ["init", "--bare", "-b", "main"]);

  await mkdir(parentRoot, { recursive: true });
  await git(parentRoot, ["init", "-b", "main"]);
  await git(parentRoot, ["config", "user.email", "parent@example.com"]);
  await git(parentRoot, ["config", "user.name", "ParentDev"]);
  await git(parentRoot, ["remote", "add", "origin", bareRemotePath]);
  await writeFile(join(parentRoot, ".gitignore"), ".atmux/\n");
  await writeFile(join(parentRoot, "README.md"), "# parent\n");
  await git(parentRoot, ["add", ".gitignore", "README.md"]);
  await git(parentRoot, ["commit", "-m", "initial parent commit"]);
  await git(parentRoot, ["push", "-u", "origin", "main"]);

  const atmuxDir = join(parentRoot, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  // tmuxTmpdir pinned at fixture so resolveTeamSocket does NOT touch
  // /tmp/atmux-atmux-test-parent on shared dev machines.
  const parentTmuxDir = join(tmpRoot, "parent-tmux");
  await mkdir(parentTmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "atmux-test-parent",
      tmuxTmpdir: parentTmuxDir,
      members: [{ name: "lead", role: "team-lead" }],
    }),
  );
  // Parent state.db seeded with the canonical EPIC row so future
  // lifecycle-walk impls have a target for dissolve-epic's parent-
  // mark-done step. Cross-team tests below do not exercise it.
  const parentDb = openDatabase(join(atmuxDir, "state.db"), migrations);
  parentDb
    .query(
      `INSERT INTO epics (id, title, status, created_at)
       VALUES ($id, $title, $status, $now)`,
    )
    .run({
      $id: "e-cross-team-flow",
      $title: "cross-team capstone",
      $status: "in-progress",
      $now: 1000,
    });
  closeDatabase(parentDb);

  await mkdir(templatesDir, { recursive: true });
  await writeFile(
    join(templatesDir, "default.json"),
    JSON.stringify({
      members: [
        { name: "lead", role: "team-lead", tui: "claude" },
        { name: "fe-1", role: "member", lane: "fe", tui: "claude" },
      ],
    }),
  );
  await writeFile(
    cockpitPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [
        {
          type: "team",
          name: "atmux-test-parent",
          enabled: true,
          root: parentRoot,
        },
      ],
    }),
  );

  return {
    tmpRoot,
    bareRemotePath,
    repoPath: parentRoot,
    atmuxDir,
    parentName: "atmux-test-parent",
    cockpitPath,
    templatesDir,
    capturedLogs: [],
  };
}

async function spawnEpicForFixture(
  fix: ParentFixtureRuntime,
  epicId: string,
): Promise<SpawnedEpic> {
  const rc = await spawnEpic(
    [
      epicId,
      "--from",
      fix.parentName,
      "--parent-base",
      "main",
      "--parent-epic-kanban-id",
      "e-cross-team-flow",
    ],
    {
      cockpitPath: fix.cockpitPath,
      templatesDir: fix.templatesDir,
      callerScope: () => "driver",
      logger: {
        log: (m) => fix.capturedLogs.push(m),
        warn: (m) => fix.capturedLogs.push(`WARN: ${m}`),
      },
    },
  );
  if (rc !== 0) {
    throw new Error(`spawn-epic exited ${rc}; logs:\n${fix.capturedLogs.join("\n")}`);
  }
  const epicRoot = join(`${fix.repoPath}-epics`, epicId);
  const epicAtmuxDir = join(epicRoot, ".atmux");
  // Pin epic-team tmuxTmpdir to the fixture too — same /tmp-leak
  // reason as parent. The socket path resolves but no server backs
  // it; tellLead's tmux send fails with the expected ConfigError.
  const teamJsonPath = join(epicAtmuxDir, "team.json");
  const teamRaw = JSON.parse(await Bun.file(teamJsonPath).text());
  const epicTmuxDir = join(fix.tmpRoot, `${epicId}-tmux`);
  await mkdir(epicTmuxDir, { recursive: true });
  teamRaw.tmuxTmpdir = epicTmuxDir;
  await writeFile(teamJsonPath, JSON.stringify(teamRaw));

  return {
    epicName: epicId,
    epicId,
    epicAtmuxDir,
    epicTmuxSocket: join(epicTmuxDir, "sock"),
  };
}

async function readInboxOrEmpty(atmuxDir: string): Promise<string> {
  // ADR-198 (2026-05-20): tell-lead writes to lead-inbox.md (canonical);
  // the read-shim in core/lead-inbox.ts still accepts legacy driver-inbox.md
  // during the grace window. Check both for parity-grade assertions —
  // either name being present satisfies the cross-team write surface.
  const canonical = Bun.file(join(atmuxDir, "lead-inbox.md"));
  if (await canonical.exists()) return canonical.text();
  const legacy = Bun.file(join(atmuxDir, "driver-inbox.md"));
  if (await legacy.exists()) return legacy.text();
  return "";
}

describe("ADR-092 cross-team tell-lead (phase-2, t-bc4fdb19)", () => {
  let fixture: ParentFixtureRuntime;
  let epic: SpawnedEpic;
  let priorCockpit: string | undefined;
  let priorScope: string | undefined;

  beforeEach(async () => {
    fixture = await makeParentFixture();
    epic = await spawnEpicForFixture(fixture, "e-cross-team");
    priorCockpit = process.env.ATMUX_COCKPIT_CONFIG;
    priorScope = process.env.ATMUX_CALLER_SCOPE;
    process.env.ATMUX_COCKPIT_CONFIG = fixture.cockpitPath;
  });

  afterEach(async () => {
    if (priorCockpit !== undefined) process.env.ATMUX_COCKPIT_CONFIG = priorCockpit;
    else delete process.env.ATMUX_COCKPIT_CONFIG;
    if (priorScope !== undefined) process.env.ATMUX_CALLER_SCOPE = priorScope;
    else delete process.env.ATMUX_CALLER_SCOPE;
    await rm(fixture.tmpRoot, { recursive: true, force: true });
    activeFixtureDirs.delete(fixture.tmpRoot);
  });

  test("parent driver → epic-lead — inbox routes to epic-team's .atmux/", async () => {
    // ADR-092 §D3 case (a): ATMUX_CALLER_SCOPE=driver is the master
    // override — routing lands without scope-gate refusal. Tmux send
    // throws in test env (no real cage server); assert inbox-write
    // durability per ADR-029 §F6 + tell-lead.ts "appendDriverInbox
    // landed before this throw" comment.
    process.env.ATMUX_CALLER_SCOPE = "driver";
    await expect(
      tellLead([
        "--team-dir",
        fixture.repoPath,
        "--team",
        epic.epicName,
        "phase-2",
        "driver",
        "ping",
      ]),
    ).rejects.toThrow(ConfigError);
    const epicInbox = await readInboxOrEmpty(epic.epicAtmuxDir);
    expect(epicInbox).toContain("phase-2 driver ping");
    // ADR-198: header text changed `# Driver Inbox` → `# Lead Inbox` on the
    // canonical write surface. Legacy header still acceptable if a fixture
    // pre-seeded driver-inbox.md.
    expect(epicInbox).toMatch(/# (Lead|Driver) Inbox/);
    // Parent inbox stays empty — routing went to epic, not source.
    const parentInbox = await readInboxOrEmpty(fixture.atmuxDir);
    expect(parentInbox).toBe("");
  });

  test("epic-lead → parent — child-to-parent allowed via §D3 case (c)", async () => {
    // ADR-092 §D3 case (c): child epic-team → its parent is allowed
    // natively (cockpit's `epicTeam.parent` linkage authorizes the
    // route). ATMUX_CALLER_SCOPE unset — gate uses cockpit topology.
    delete process.env.ATMUX_CALLER_SCOPE;
    const epicRoot = join(`${fixture.repoPath}-epics`, epic.epicName);
    await expect(
      tellLead([
        "--team-dir",
        epicRoot,
        "--team",
        fixture.parentName,
        "phase-2",
        "epic-up",
        "ping",
      ]),
    ).rejects.toThrow(ConfigError);
    const parentInbox = await readInboxOrEmpty(fixture.atmuxDir);
    expect(parentInbox).toContain("phase-2 epic-up ping");
    // Epic inbox stays empty — routing went up, not back to source.
    const epicInbox = await readInboxOrEmpty(epic.epicAtmuxDir);
    expect(epicInbox).toBe("");
  });

  test("unrelated team → epic — caller-scope refused, NO inbox write either side", async () => {
    // ADR-092 §D3 case (e/g): an unrelated source team → target is
    // refused before any inbox mutation. Refusal text names both
    // endpoints per Decision-anchor #5. Stage a third "outsider"
    // team in cockpit (no parent linkage), point --team-dir at its
    // root, assert refusal lands BEFORE appendDriverInbox.
    const outsiderRoot = join(fixture.tmpRoot, "outsider-team");
    const outsiderAtmux = join(outsiderRoot, ".atmux");
    await mkdir(outsiderAtmux, { recursive: true });
    const outsiderTmuxDir = join(fixture.tmpRoot, "outsider-tmux");
    await mkdir(outsiderTmuxDir, { recursive: true });
    await writeFile(
      join(outsiderAtmux, "team.json"),
      JSON.stringify({
        name: "outsider-team",
        tmuxTmpdir: outsiderTmuxDir,
        members: [{ name: "lead", role: "team-lead" }],
      }),
    );
    // Append outsider into the cockpit alongside parent (NOT under
    // it — sibling, not child).
    const cockpitText = await Bun.file(fixture.cockpitPath).text();
    const cockpit = JSON.parse(cockpitText);
    cockpit.sessions.push({
      type: "team",
      name: "outsider-team",
      enabled: true,
      root: outsiderRoot,
    });
    await writeFile(fixture.cockpitPath, JSON.stringify(cockpit));

    delete process.env.ATMUX_CALLER_SCOPE;
    await expect(
      tellLead(["--team-dir", outsiderRoot, "--team", epic.epicName, "should be refused"]),
    ).rejects.toThrow(/refused/);
    // Critical: refusal fires BEFORE appendDriverInbox — neither
    // source nor target inbox has the message.
    const epicInbox = await readInboxOrEmpty(epic.epicAtmuxDir);
    expect(epicInbox).toBe("");
    const outsiderInbox = await readInboxOrEmpty(outsiderAtmux);
    expect(outsiderInbox).toBe("");
  });
});

// =========================================================================
// PHASE-2 DEFERRED — doctor D5a / D8 / D9 (gated on t-c2e544b6)
// =========================================================================
//
// Doctor probe surfaces are NOT yet on trunk (t-c2e544b6 owns them).
// Captured here as `test.todo` placeholders so phase-2's residual
// scope is visible at file-grep time + the follow-up claimant has a
// turnkey wiring spec. The Task body's AC bullet #2 (D5a/D8/D9
// assertions fire) re-claims as t-c2e544b6 ships.
//
//   - D5a — submodule pointer integrity (extends ADR-057 §D5a for
//           epic-team awareness). Helper: build a corrupted submodule
//           pointer in an epic-team worktree + assert doctor row
//           severity.
//   - D8  — `epicTeam.parent` reachability. Helper: spawn epic, then
//           remove parent from cockpit; assert orphan-epic P1 row.
//   - D9  — prefix-level consistency. Every cage tmux.conf prefix
//           must match `ATMUX_NESTING_LEVEL` env (ADR-089). Helper:
//           build mismatched prefix env + tmux.conf; assert mismatch
//           row.
//
// Adjacent-flag deferrals (auto-mode capstone bypasses; pr-mode
// follow-up territory — t-cc4c5fd9 audit):
//   - gh-CLI auth-switch race under pr-mode.
//   - Claude API rate-limit ceiling at 2 epics × 7 members = 14 TUIs.
//   - GitHub Actions cross-account secret scoping.

describe.todo("ADR-092 doctor D5a/D8/D9 (deferred to t-c2e544b6)", () => {
  test.todo("D5a — submodule pointer integrity for epic-team worktree", () => {
    // Build corrupted submodule pointer in epic-team worktree;
    // assert doctor row severity per ADR-057 §D5a extension.
  });
  test.todo("D8 — orphan epic-team surfaces when parent removed mid-lifecycle", () => {
    // Spawn epic, remove parent from cockpit; assert orphan-epic P1
    // doctor row.
  });
  test.todo("D9 — prefix-level consistency across cage tmux.conf + env", () => {
    // Build mismatched ATMUX_NESTING_LEVEL env vs tmux.conf prefix;
    // assert mismatch row.
  });
});
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
