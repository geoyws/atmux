// E2E dogfood for ADR-144 epic-team test-gate (Task t-45d59eeb / T5).
// Exercises the full T2/T3/T4 chain end-to-end in BOTH modes (cage +
// deployed) plus the operator-bypass path, asserting:
//
//   1. Cage-mode PASS (true exit 0) — gate transitions
//      ready_to_merge → tested → merging → merged, Discord
//      `[epic-test-pass]` fires once, parent-trunk carries the merge.
//   2. Cage-mode FAIL (false exit 1) — gate transitions
//      ready_to_merge → tested → test_failed, Discord
//      `[epic-test-fail]` fires once, parent-trunk UNCHANGED.
//   3. Cage-mode retryOnFlake (flake-then-pass via a counter
//      script) — recovers to PASS on second attempt; Discord
//      `[epic-test-pass]` fires once with `attempts: 2`.
//   4. Deployed-mode PASS — testGate hook is injected directly
//      (deploy lifecycle is out-of-scope per ADR-144 §Mode-A-deployed
//      "lifecycle hooks fire at spawn-epic / dissolve-epic"); fixture
//      pins `stagingUrlTemplate` + asserts the URL composition path.
//   5. Operator bypass — `atmux epic-merge advance --to merging
//      --skip-test-gate --reason "<text>"` writes the JSONL log
//      entry + fires Discord `[test-gate-bypass]` + advances row.
//
// Mirrors the fixture shape in tests/e2e/epic-auto-merge.test.ts (real
// bare remote + working clone + scratch cockpit). Cage-mode tests rely
// on `/usr/bin/true` and `/usr/bin/false` POSIX binaries as the
// testCommand — exit code is the only signal the runner needs, no
// dependency on bun test scaffolding (which would re-trigger the bun-
// test orphan-survival path per [[feedback_pause_bun_tests]]).
//
// Per CLAUDE.md §Testing Discipline these are stateful e2e walks; each
// test cold-starts a fresh mkdtemp'd fixture and tears down in
// afterEach. Per memory `feedback_pause_bun_tests.md` operator runs
// these via `unset TMUX && bun test` to avoid parent-cage propagation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordSendOpts } from "../../src/abstractions/discord.ts";
import { closeDatabase, openDatabase } from "../../src/abstractions/sqlite.ts";
import { migrations } from "../../src/abstractions/sqlite-migrations.ts";
import { defaultGitSpawn } from "../../src/abstractions/worktree.ts";
import { epicMergeAdvanceVerb, epicMergeTickVerb } from "../../src/verbs/epic-merge.ts";
import { spawnEpic } from "../../src/verbs/team/spawn-epic.ts";

// ---------- Helpers ----------

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
  tmpRoot: string;
  bareRemotePath: string;
  parentRoot: string;
  cockpitPath: string;
  templatesDir: string;
  capturedLogs: string[];
  capturedDiscord: DiscordSendOpts[];
}

/** Cold-start a parent-team fixture + register the parent in the
 *  scratch cockpit. Identical shape to tests/e2e/epic-auto-merge.test
 *  but parameterised on the test-gate roster preset name. */
async function makeFixture(): Promise<Fixture> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "atmux-e2e-test-gate-"));
  const bareRemotePath = join(tmpRoot, "origin.git");
  const parentRoot = join(tmpRoot, "parent-team");
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

  await mkdir(join(parentRoot, ".atmux"), { recursive: true });
  await writeFile(
    join(parentRoot, ".atmux", "team.json"),
    JSON.stringify({
      name: "parent-team",
      members: [{ name: "lead", role: "lead" }],
    }),
  );
  const parentDb = openDatabase(join(parentRoot, ".atmux", "state.db"), migrations);
  parentDb
    .query(
      `INSERT INTO epics (id, title, status, created_at)
       VALUES ($id, $title, $status, $now)`,
    )
    .run({
      $id: "e-e-gate-flow",
      $title: "test-gate flow epic",
      $status: "in-progress",
      $now: 1000,
    });
  closeDatabase(parentDb);

  await mkdir(templatesDir, { recursive: true });
  // Default roster + nothing else — the gate config is patched onto
  // the child team.json post-spawn via writeChildTeamJson() below.
  await writeFile(
    join(templatesDir, "default.json"),
    JSON.stringify({
      members: [
        { name: "lead", role: "lead", tui: "claude" },
        { name: "be-1", role: "member", lane: "be", tui: "claude" },
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
          name: "parent-team",
          enabled: true,
          root: parentRoot,
        },
      ],
    }),
  );

  return {
    tmpRoot,
    bareRemotePath,
    parentRoot,
    cockpitPath,
    templatesDir,
    capturedLogs: [],
    capturedDiscord: [],
  };
}

/** Spawn the epic-team via the real verb. */
async function spawnEpicForFixture(
  fix: Fixture,
  epicId: string,
): Promise<{ epicRoot: string; epicBranch: string }> {
  const rc = await spawnEpic(
    [
      epicId,
      "--from",
      "parent-team",
      "--parent-base",
      "main",
      "--parent-epic-kanban-id",
      "e-e-gate-flow",
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
  const epicRoot = join(`${fix.parentRoot}-epics`, epicId);
  const epicBranch = `main-epic-${epicId}`;
  return { epicRoot, epicBranch };
}

/** Patch the child team.json with ADR-144 epicTeam.test* fields.
 *  Cage mode is the default for atmux-self; deployed is exercised via
 *  the dedicated section below. */
async function patchChildTeamJson(
  epicRoot: string,
  patch: {
    testGateMode: "cage" | "deployed";
    testCommand: string;
    retryOnFlake?: number;
    cageTmpdir?: string;
    stagingUrlTemplate?: string;
  },
): Promise<void> {
  const teamJsonPath = join(epicRoot, ".atmux", "team.json");
  const cur = JSON.parse(await readFile(teamJsonPath, "utf8")) as Record<string, unknown>;
  const epicTeam = (cur.epicTeam ?? {}) as Record<string, unknown>;
  epicTeam.testGateMode = patch.testGateMode;
  epicTeam.testCommand = patch.testCommand;
  if (patch.retryOnFlake !== undefined) epicTeam.retryOnFlake = patch.retryOnFlake;
  if (patch.cageTmpdir !== undefined) epicTeam.cageTmpdir = patch.cageTmpdir;
  if (patch.stagingUrlTemplate !== undefined) {
    epicTeam.stagingUrlTemplate = patch.stagingUrlTemplate;
  }
  cur.epicTeam = epicTeam;
  await writeFile(teamJsonPath, JSON.stringify(cur, null, 2));
}

/** Pre-advance the merger_state row to `ready_to_merge` so the next
 *  tick fires the test-gate hook immediately (avoids the
 *  open→in_progress→ready_to_merge multi-tick walk that the parent
 *  e2e suite already covers). The seeded row mirrors what
 *  `runAutoMerge` would produce on a 2-tick happy-path. Column names
 *  match the migration v1 shape: `transitioned_by` (NOT `by`). */
async function seedReadyToMerge(epicRoot: string, epicBranch: string): Promise<void> {
  const db = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
  db.query(
    `INSERT OR REPLACE INTO merger_state
       (member_branch, state, note, transitioned_at, transitioned_by, base_sha, conflict_sha, test_outcome)
     VALUES ($branch, 'ready_to_merge', 'seeded by e2e', 1000, 'test', NULL, NULL, NULL)`,
  ).run({ $branch: epicBranch });
  closeDatabase(db);
}

/** Tick epic-merge against the epic-team's worktree. Injects only
 *  {@link EpicMergeOpts.discordSend} — capture stub so the test
 *  asserts template fires without hitting the real
 *  `ATMUX_DISCORD_WEBHOOK`. The production `defaultResolveGate` runs
 *  unchanged — post-t-95264384 it reads `extra->>'$.role'` (the
 *  passthrough JSON path) so it works against the v1 tasks schema.
 *  Note: the seeded `ready_to_merge` row in merger_state means the
 *  state machine never consumes gate facts in this fixture (gate is
 *  only read from `in_progress`); the production resolver still runs
 *  and must not throw. */
async function tick(fix: Fixture, epicRoot: string): Promise<string[]> {
  const logs: string[] = [];
  await epicMergeTickVerb(
    { subverb: "tick", teamDir: epicRoot },
    {
      discordSend: async (o) => {
        fix.capturedDiscord.push(o);
      },
      logger: {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(`WARN: ${m}`),
        err: (m: string) => logs.push(`ERR: ${m}`),
        ok: (m: string) => logs.push(`OK: ${m}`),
      },
    },
  );
  return logs;
}

/** Commit a real change on the epic-team's branch so HEAD is ahead
 *  of parentBase (required for merge to be a non-no-op). */
async function commitFeature(epicRoot: string, name: string): Promise<void> {
  await git(epicRoot, ["config", "user.email", "epic@example.com"]);
  await git(epicRoot, ["config", "user.name", "EpicDev"]);
  await writeFile(join(epicRoot, `${name}.md`), `${name}\n`);
  await git(epicRoot, ["add", `${name}.md`]);
  await git(epicRoot, ["commit", "-m", `feat: ${name}`]);
}

// ---------- Fixture lifecycle ----------

let fix: Fixture;

beforeEach(async () => {
  fix = await makeFixture();
});

afterEach(async () => {
  await rm(fix.tmpRoot, { recursive: true, force: true });
});

// ---------- Cage mode ----------

describe("ADR-144 cage-mode test-gate (e2e)", () => {
  test("PASS path: ready_to_merge → tested → merging → merged + Discord [epic-test-pass]", async () => {
    const { epicRoot, epicBranch } = await spawnEpicForFixture(fix, "cage-pass");
    await commitFeature(epicRoot, "feature-a");
    await patchChildTeamJson(epicRoot, {
      testGateMode: "cage",
      testCommand: "/usr/bin/true",
      cageTmpdir: join(fix.tmpRoot, "cage-${team}-${epic}"),
    });
    await seedReadyToMerge(epicRoot, epicBranch);

    // Tick #1: ready_to_merge → tested(pass) → merging → merged.
    const log1 = (await tick(fix, epicRoot)).join("\n");
    expect(log1).toMatch(/state='merged'/);

    // Discord [epic-test-pass] fires exactly once on this tick.
    const passes = fix.capturedDiscord.filter((d) => d.template === "epic-test-pass");
    expect(passes).toHaveLength(1);
    const pass = passes[0]!;
    expect(pass.category).toBe("🚀");
    // Verdict surfaces the parentEpicKanbanId ("e-e-gate-flow" from
    // fixture), not the epic dir name ("cage-pass"). The kanbanId is
    // the operator's primary correlation key with merger_state +
    // atmux status.
    expect(String(pass.verdict)).toContain("e-e-gate-flow");
    expect(String(pass.verdict)).toContain("test-gate passed");

    // No FAIL template, no BYPASS template on a clean PASS.
    expect(fix.capturedDiscord.some((d) => d.template === "epic-test-fail")).toBe(false);
    expect(fix.capturedDiscord.some((d) => d.template === "test-gate-bypass")).toBe(false);

    // Parent's main carries the child commit under --no-ff merge.
    const parentLog = await git(fix.parentRoot, ["log", "--all", "--oneline"]);
    expect(parentLog).toContain("feat: feature-a");
  });

  test("FAIL path: ready_to_merge → tested → test_failed + Discord [epic-test-fail], parent untouched", async () => {
    const { epicRoot, epicBranch } = await spawnEpicForFixture(fix, "cage-fail");
    await commitFeature(epicRoot, "feature-b");
    await patchChildTeamJson(epicRoot, {
      testGateMode: "cage",
      testCommand: "/usr/bin/false",
      retryOnFlake: 0,
      cageTmpdir: join(fix.tmpRoot, "cage-${team}-${epic}"),
    });
    await seedReadyToMerge(epicRoot, epicBranch);

    const log1 = (await tick(fix, epicRoot)).join("\n");
    expect(log1).toMatch(/state='test_failed'/);

    const fails = fix.capturedDiscord.filter((d) => d.template === "epic-test-fail");
    expect(fails).toHaveLength(1);
    const fail = fails[0]!;
    expect(fail.category).toBe("🛑");
    expect(String(fail.verdict)).toContain("test-gate FAILED");
    expect(String(fail.verdict)).toContain("parent-trunk untouched");

    // PASS template not fired on FAIL outcome.
    expect(fix.capturedDiscord.some((d) => d.template === "epic-test-pass")).toBe(false);

    // Parent's `main` does NOT carry the child commit (gate refused).
    // `git log --all` would show it on the epic branch (which is
    // correct — the commit exists, just isn't merged); the gate
    // contract is "parent-trunk untouched" so we check main only.
    const parentMainLog = await git(fix.parentRoot, ["log", "main", "--oneline"]);
    expect(parentMainLog).not.toContain("feat: feature-b");
  });

  test("retryOnFlake=1: first-fail then second-pass recovers + Discord [epic-test-pass] with attempts=2", async () => {
    const { epicRoot, epicBranch } = await spawnEpicForFixture(fix, "cage-flake");
    await commitFeature(epicRoot, "feature-c");

    // Stub script: succeeds only on the 2nd invocation. Counter file
    // lives in the fixture tmp root so it survives across cage
    // provision/teardown cycles (cage tmpdir is wiped per-run).
    const counterFile = join(fix.tmpRoot, "flake-counter");
    await writeFile(counterFile, "");
    const flakeScript = join(fix.tmpRoot, "flake.sh");
    await writeFile(
      flakeScript,
      `#!/usr/bin/env bash
n=$(wc -c < "${counterFile}")
echo "x" >> "${counterFile}"
if [ "$n" -lt "1" ]; then
  exit 1
fi
exit 0
`,
    );
    await chmod(flakeScript, 0o755);

    await patchChildTeamJson(epicRoot, {
      testGateMode: "cage",
      testCommand: flakeScript,
      retryOnFlake: 1,
      cageTmpdir: join(fix.tmpRoot, "cage-${team}-${epic}"),
    });
    await seedReadyToMerge(epicRoot, epicBranch);

    const log1 = (await tick(fix, epicRoot)).join("\n");
    expect(log1).toMatch(/state='merged'/);

    const passes = fix.capturedDiscord.filter((d) => d.template === "epic-test-pass");
    expect(passes).toHaveLength(1);
    const pass = passes[0]!;
    const bullets = (pass.bullets ?? []) as string[];
    // attempts=2 surfaces via the ✅ bullet's "2 attempts" verbiage.
    expect(bullets.some((b) => b.startsWith("✅") && b.includes("2 attempts"))).toBe(true);
  });
});

// ---------- Deployed mode ----------

describe("ADR-144 deployed-mode test-gate (e2e)", () => {
  test("DNS-unresolved staging URL → test_failed + Discord [epic-test-fail] with 'deployed' mode in verdict", async () => {
    // Deployed-mode runs a pre-flight wildcard-DNS probe on
    // `runDeployedTestGate` (per epic-test-deploy.ts §runDeployedTestGate)
    // and short-circuits to `fail` on unresolve. This is the gate's
    // protective behaviour for misconfigured deploys: rather than let
    // the test command fail with noisy network errors against a
    // missing URL, the gate surfaces a clear "DNS not configured"
    // refusal. Using `.example.invalid` (RFC 6761 reserved) guarantees
    // unresolve, so this is the deterministic e2e for deployed-mode
    // FAIL path + Discord template wire-up. The PASS path requires a
    // resolvable staging URL + a real or stubbed e2e runner, which
    // is exercised in production (an IFCA product team) rather than
    // in this dogfood test — the test-gate wiring is identical at
    // the verb layer.
    const { epicRoot, epicBranch } = await spawnEpicForFixture(fix, "dep-dns-fail");
    await commitFeature(epicRoot, "feature-d");
    await patchChildTeamJson(epicRoot, {
      testGateMode: "deployed",
      testCommand: "/usr/bin/true",
      retryOnFlake: 0,
      stagingUrlTemplate: "atmux-test-${epic-name}.example.invalid",
    });
    await seedReadyToMerge(epicRoot, epicBranch);

    const log1 = (await tick(fix, epicRoot)).join("\n");
    expect(log1).toMatch(/state='test_failed'/);
    // ADR-144 §Two test-isolation modes: composeStagingUrl expands
    // the `${epic-name}` placeholder using `parentEpicKanbanId` with
    // the `e-` prefix stripped — fixture's `e-e-gate-flow` becomes
    // `e-gate-flow` here. Surfaces in merger_state.note via the
    // tick log line.
    expect(log1).toContain("https://atmux-test-e-gate-flow.example.invalid");

    const fails = fix.capturedDiscord.filter((d) => d.template === "epic-test-fail");
    expect(fails).toHaveLength(1);
    expect(String(fails[0]!.verdict)).toContain("deployed");
    expect(String(fails[0]!.verdict)).toContain("test-gate FAILED");
  });
});

// ---------- Operator bypass ----------

describe("ADR-144 §Operator bypass (e2e)", () => {
  test("advance --to merging --skip-test-gate writes JSONL log + fires Discord [test-gate-bypass]", async () => {
    const { epicRoot, epicBranch } = await spawnEpicForFixture(fix, "bypass");
    // Seed merger_state at `tested` with a `fail` outcome (the bypass
    // scenario: tests failed but operator needs to ship anyway).
    const db = openDatabase(join(epicRoot, ".atmux", "state.db"), migrations);
    db.query(
      `INSERT OR REPLACE INTO merger_state
         (member_branch, state, note, transitioned_at, transitioned_by, base_sha, conflict_sha, test_outcome)
       VALUES ($branch, 'tested', 'seed', 1000, 'test', NULL, NULL, 'fail')`,
    ).run({ $branch: epicBranch });
    closeDatabase(db);

    const scratchHome = join(fix.tmpRoot, "fake-home");
    await mkdir(scratchHome, { recursive: true });

    const rc = await epicMergeAdvanceVerb(
      {
        subverb: "advance",
        to: "merging",
        skipTestGate: true,
        reason: "demo-day emergency — flake under retry, accepting risk",
        teamDir: epicRoot,
      },
      {
        callerScope: () => "driver",
        homeDir: scratchHome,
        user: "george",
        now: () => 1_700_000_000_000,
        discordSend: async (o) => {
          fix.capturedDiscord.push(o);
        },
        logger: {
          log: (m: string) => fix.capturedLogs.push(m),
          warn: (m: string) => fix.capturedLogs.push(`WARN: ${m}`),
          err: (m: string) => fix.capturedLogs.push(`ERR: ${m}`),
          ok: (m: string) => fix.capturedLogs.push(`OK: ${m}`),
        },
      },
    );
    expect(rc).toBe(0);

    // JSONL audit log lands.
    const logTxt = await readFile(join(scratchHome, ".atmux/state/test-gate-bypasses.log"), "utf8");
    const parsed = JSON.parse(logTxt.trim().split("\n")[0] ?? "{}");
    // Bypass log records parentEpicKanbanId from team.json (the
    // canonical operator-correlation id), NOT the epic dir name.
    expect(parsed.epicId).toBe("e-e-gate-flow");
    expect(parsed.targetState).toBe("merging");
    expect(parsed.reason).toContain("demo-day emergency");
    expect(parsed.by).toBe("george");

    // Discord [test-gate-bypass] fires once.
    const bypasses = fix.capturedDiscord.filter((d) => d.template === "test-gate-bypass");
    expect(bypasses).toHaveLength(1);
    expect(bypasses[0]!.category).toBe("⚠️");
    expect(String(bypasses[0]!.verdict)).toContain("BYPASSED");
    const bullets = (bypasses[0]!.bullets ?? []) as string[];
    expect(bullets.some((b) => b.startsWith("🆔") && b.includes("george"))).toBe(true);
    expect(bullets.some((b) => b.startsWith("🚩") && b.includes("demo-day emergency"))).toBe(true);
  });
});
