// e2e — the ADR-092 cross-team `tell-lead` caller-scope gate, driven
// against a real on-disk parent + nested child cage and a real cockpit
// fixture (Task t-edc93b42 → t-bc4fdb19).
//
// **ADR-280 stage 4 rescoped this file.** It began as the pre-sopx
// team-of-teams capstone: a phase-1 skeleton of `test.todo` placeholders
// for the epic-team lifecycle (spawn 2 epics in parallel → seed tasks →
// walk them → fan member branches into the epic trunk → fan the epic
// trunk into the parent trunk → dissolve → mark the KanbanEpic done →
// assert no leakage), plus three phase-2 tests that DID land. Every stage
// of the skeleton named a verb ADR-280 stages 2/3 deleted, so the
// skeleton is gone — not deferred, retired.
//
// The three landed tests remain, and they are not epic machinery. They
// cover ADR-092 §D3's symmetric caller-scope gate:
//
//   (a) `ATMUX_CALLER_SCOPE=driver` is the master override;
//   (c) a child cage → its parent is allowed from cockpit topology alone;
//   (e/g) an unrelated sibling → the child is refused, and refused BEFORE
//         any inbox mutation.
//
// Case (c) is the one stage 3 WIDENED. The gate used to reach a parent
// only through an `epic-team` node's own `parent` back-pointer, so it
// covered epic-teams and nothing else; `parent` is now derived from the
// cockpit walk's ancestry, so the route holds for any nested team. The
// fixture therefore builds an ordinary nested `team` node, and passing
// here is the end-to-end evidence for that widening.
//
// Tmux-send failure in the test process (no real cage server) is the
// EXPECTED terminal failure mode. Each assertion reads the durable
// inbox write, which lands BEFORE the tmux send (ADR-029 §F6 + §F7, and
// the "appendDriverInbox already landed before this throw" comment in
// tell-lead.ts).
//
// Per ADR-029 §F1 "stateful e2e specs are not repeatable smokes" — this
// is a cold-start integration spec, not a streak-runnable stability
// smoke.
//
// **Out of scope:** sopx-side migration (operator-driven),
// member-to-member cross-team messaging.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { defaultGitSpawn } from "../../src/abstractions/worktree.ts";
import { ConfigError } from "../../src/errors.ts";
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
      // for any spawned cage tmux sockets.
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
// FIXTURE HELPER SIGNATURES
// =========================================================================
//
// ADR-280 stage 4 removed the phase-1 epic-lifecycle skeleton that stood
// here: the `SpawnedEpic` / `LifecycleSnapshot` / `DissolutionResult`
// signatures and the eight-stage `describe.skip` walk (spawn-parallel →
// seed → task walk → epic-trunk fan-in → parent-trunk merge →
// dissolve-epic → KanbanEpic done → no-leakage). Every stage of that walk
// named a verb ADR-280 stages 2/3 deleted, so it was a specification for
// work that will not be done — not deferred coverage. It is deleted
// rather than left as `test.todo`, because a todo for a retired concept
// reads as outstanding work forever.
//
// What SURVIVES, and is implemented below, is the ADR-092 cross-team
// `tell-lead` surface. That is not epic machinery: stage 3 kept
// `callerScopeAllowed` and WIDENED it — `parent` now comes from the
// cockpit walk's ancestry instead of an `epic-team`-only back-pointer, so
// the parent↔child gate covers any nested team. These three tests are the
// only end-to-end coverage of that gate, and the child cage they need is
// now built directly instead of via the deleted `spawn-epic` verb.

interface ParentFixture {
  readonly tmpRoot: string;
  readonly bareRemotePath: string;
  readonly repoPath: string;
  readonly atmuxDir: string;
  /** Parent team name; canonical for these tests is `"atmux-test-parent"`. */
  readonly parentName: string;
}

/** A child cage nested under the parent, as the cockpit sees it. */
interface NestedChild {
  readonly childName: string;
  readonly childRoot: string;
  readonly childAtmuxDir: string;
  readonly childTmuxSocket: string;
}

// =========================================================================
// PHASE-2 IMPLEMENTATIONS (t-bc4fdb19) — ADR-092 cross-team tell-lead
// =========================================================================
//
// Three INTEGRATION-shaped tests exercise the ADR-092 verb surface
// against real cockpit fixtures. Tmux-send failure in the test process
// (no real cage server) is the EXPECTED terminal failure mode;
// assertion uses the durable inbox-write that lands BEFORE the tmux
// send (per ADR-029 §F6 + F7 + the tell-lead.ts "appendDriverInbox
// already landed before this throw" comment).

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
  const templatesDir = join(tmpRoot, "templates", "rosters");

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
  // Parent state.db seeded with one kanban Epic row. The kanban Epic
  // WORK ITEM survives the epic-TEAM retirement (ADR-280 §D5 leaves it
  // under ADR-275's gate), and the row keeps the fixture's state.db
  // representative of a real parent. Cross-team tests do not read it.
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

/** Build a child cage NESTED under the parent, both on disk and in the
 *  cockpit tree.
 *
 *  ADR-280 stage 4: this replaces `spawnEpicForFixture`, which drove
 *  `atmux team spawn-epic` to lay down `<parent>-epics/<epicId>/` and
 *  register an `epic-team` cockpit node. Neither the verb nor the node
 *  type exists. The cockpit shape it produces is what the gate under
 *  test actually reads — a `team` node nested inside the parent's
 *  `sessions[]`, with its own root — and `callerScopeAllowed` derives
 *  the parent link from that nesting rather than from a declared field. */
async function makeNestedChild(fix: ParentFixtureRuntime, childName: string): Promise<NestedChild> {
  const childRoot = join(fix.tmpRoot, childName);
  const childAtmuxDir = join(childRoot, ".atmux");
  await mkdir(childAtmuxDir, { recursive: true });

  // tmuxTmpdir pinned at the fixture for the same /tmp-leak reason as
  // the parent: the socket path resolves but no server backs it, so
  // tellLead's tmux send fails with the expected ConfigError AFTER the
  // durable inbox write has landed.
  const childTmuxDir = join(fix.tmpRoot, `${childName}-tmux`);
  await mkdir(childTmuxDir, { recursive: true });
  await writeFile(
    join(childAtmuxDir, "team.json"),
    JSON.stringify({
      name: childName,
      tmuxTmpdir: childTmuxDir,
      members: [{ name: "lead", role: "team-lead" }],
    }),
  );

  // Nest the child INSIDE the parent's sessions[] — this is the only
  // thing that makes it a child as far as the gate is concerned.
  const cockpit = JSON.parse(await Bun.file(fix.cockpitPath).text()) as {
    sessions: Array<{ name: string; sessions?: unknown[] }>;
  };
  const parentNode = cockpit.sessions.find((n) => n.name === fix.parentName);
  if (parentNode === undefined) throw new Error("parent node missing from cockpit fixture");
  parentNode.sessions = [
    ...(parentNode.sessions ?? []),
    { type: "team", name: childName, enabled: true, root: childRoot },
  ];
  await writeFile(fix.cockpitPath, JSON.stringify(cockpit));

  return {
    childName,
    childRoot,
    childAtmuxDir,
    childTmuxSocket: join(childTmuxDir, "sock"),
  };
}

async function readInboxOrEmpty(atmuxDir: string): Promise<string> {
  const path = join(atmuxDir, "driver-inbox.md");
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : "";
}

describe("ADR-092 cross-team tell-lead (phase-2, t-bc4fdb19)", () => {
  let fixture: ParentFixtureRuntime;
  let child: NestedChild;
  let priorCockpit: string | undefined;
  let priorScope: string | undefined;

  beforeEach(async () => {
    fixture = await makeParentFixture();
    child = await makeNestedChild(fixture, "child-cross-team");
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

  test("parent driver → child lead — inbox routes to the CHILD's .atmux/", async () => {
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
        child.childName,
        "phase-2",
        "driver",
        "ping",
      ]),
    ).rejects.toThrow(ConfigError);
    const childInbox = await readInboxOrEmpty(child.childAtmuxDir);
    expect(childInbox).toContain("phase-2 driver ping");
    expect(childInbox).toContain("# Driver Inbox");
    // Parent inbox stays empty — routing went to the child, not source.
    const parentInbox = await readInboxOrEmpty(fixture.atmuxDir);
    expect(parentInbox).toBe("");
  });

  test("child lead → parent — child-to-parent allowed via §D3 case (c)", async () => {
    // ADR-092 §D3 case (c): a child cage → its parent is allowed
    // natively. ATMUX_CALLER_SCOPE unset, so the gate resolves the link
    // purely from cockpit topology — and THIS is the case ADR-280 stage
    // 3 widened: the parent used to be read off the `epic-team` node's
    // own back-pointer, so an ordinary nested team would have been
    // refused here. It is now derived from the walk's ancestry, so the
    // route holds for any nesting.
    delete process.env.ATMUX_CALLER_SCOPE;
    await expect(
      tellLead([
        "--team-dir",
        child.childRoot,
        "--team",
        fixture.parentName,
        "phase-2",
        "child-up",
        "ping",
      ]),
    ).rejects.toThrow(ConfigError);
    const parentInbox = await readInboxOrEmpty(fixture.atmuxDir);
    expect(parentInbox).toContain("phase-2 child-up ping");
    // Child inbox stays empty — routing went up, not back to source.
    const childInbox = await readInboxOrEmpty(child.childAtmuxDir);
    expect(childInbox).toBe("");
  });

  test("unrelated team → child — caller-scope refused, NO inbox write either side", async () => {
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
      tellLead(["--team-dir", outsiderRoot, "--team", child.childName, "should be refused"]),
    ).rejects.toThrow(/refused/);
    // Critical: refusal fires BEFORE appendDriverInbox — neither
    // source nor target inbox has the message.
    const childInbox = await readInboxOrEmpty(child.childAtmuxDir);
    expect(childInbox).toBe("");
    const outsiderInbox = await readInboxOrEmpty(outsiderAtmux);
    expect(outsiderInbox).toBe("");
  });
});

// =========================================================================
// DEFERRED — doctor D9 (gated on t-c2e544b6)
// =========================================================================
//
// ADR-280 stage 4 dropped two of the three deferred doctor probes: D5a
// (submodule-pointer integrity for an epic-team worktree) and D8
// (`epicTeam.parent` reachability). Both named the retired type and the
// retired schema field, so neither is outstanding work any more. D9 is
// nesting-general and survives.
//
//   - D9 — prefix-level consistency. Every cage tmux.conf prefix must
//           match `ATMUX_NESTING_LEVEL` env (ADR-089). Helper: build
//           mismatched prefix env + tmux.conf; assert mismatch row.

describe.todo("ADR-092 doctor D9 (deferred to t-c2e544b6)", () => {
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
