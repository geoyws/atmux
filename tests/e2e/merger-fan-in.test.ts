// E2E for ADR-179 §Decision-3+4+5+6 (Task t-7a7f0825 W8).
//
// Walks the merger fan-in path end-to-end against a real git repo
// with per-member worktrees:
//
//   1. Fresh git repo + bare remote + atmux team config with
//      worktreeIsolation:true + merger.enabled:true.
//   2. Per-member worktrees provisioned via `provisionWorktree`
//      (ADR-082 W1 primitive); each member commits 1-2 files on
//      their `<base>-<member>` branch.
//   3. `merge-cycle --dry-run` lists prospective merges with NO git
//      state mutation.
//   4. `merge-cycle --push` lands all clean merges; base advances by
//      ≥N merge commits; remote receives the push.
//   5. Conflict isolation: one member's commit collides with another
//      → that member's branch unmerged + flag raised; siblings
//      still land cleanly.
//   6. Doctor's `merger-branch-stale` probe: backdate a member's
//      commit → `checkMergerFanIn` returns a yellow row.
//
// Non-idempotent — each `test()` cold-starts a fresh mkdtemp'd repo
// per the CLAUDE.md "stateful e2e specs are not repeatable smokes"
// discipline. Run-of-N would consume the seed.
//
// Out-of-scope (per Task body §7 — defer to a separate task):
//   - `atmux stop --force` cleanup verification. The stop verb's
//     internal session/tmux state probes are heavy + orthogonal to
//     the fan-in correctness this test certifies. ADR-179 W8b can
//     pick that up as a sibling e2e once needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitSpawn, provisionWorktree } from "../../src/abstractions/worktree.ts";
import type { Team } from "../../src/schema/team.ts";
import { checkMergerFanIn } from "../../src/verbs/doctor.ts";
import { mergeCycle } from "../../src/verbs/merge-cycle.ts";

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
  /** Path to the team's repo root (also the parent worktree). */
  repoPath: string;
  /** Path to the bare remote at `<tmpRoot>/origin.git`. */
  bareRemotePath: string;
  /** Path to the team's `.atmux/` dir. */
  atmuxDir: string;
}

/** Cold-start a fresh fixture: bare remote + working repo + initial
 *  commit on `main` + atmux team.json with merger.enabled=true. */
async function makeFixture(): Promise<Fixture> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "atmux-e2e-merger-"));
  const bareRemotePath = join(tmpRoot, "origin.git");
  const repoPath = join(tmpRoot, "work");

  // Bare remote
  await mkdir(bareRemotePath, { recursive: true });
  await git(bareRemotePath, ["init", "--bare", "-b", "develop"]);

  // Working clone
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init", "-b", "develop"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Test"]);
  await git(repoPath, ["remote", "add", "origin", bareRemotePath]);
  // Ignore .atmux/ so the team's state dir + per-member worktrees
  // don't show up in `git status --porcelain` (which would trip W1's
  // `guardBaseWorktreeClean` refuse-gate during merge-cycle).
  await writeFile(join(repoPath, ".gitignore"), ".atmux/\n");
  await writeFile(join(repoPath, "README.md"), "# initial\n");
  await git(repoPath, ["add", ".gitignore", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  await git(repoPath, ["push", "-u", "origin", "develop"]);

  // team.json with merger enabled. Members aren't actually spawned —
  // we drive merge-cycle programmatically; the file just needs to
  // satisfy `requireTeam` + carry `merger.enabled: true`.
  const atmuxDir = join(repoPath, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "merger-test-team",
      members: [
        { name: "alpha", role: "member" },
        { name: "bob", role: "member" },
        { name: "charlie", role: "member" },
      ],
      worktreeIsolation: true,
      merger: { enabled: true, baseBranch: "develop" },
    }),
  );

  return { repoPath, bareRemotePath, atmuxDir };
}

/** Provision a member's worktree on the per-member branch and commit
 *  N files. Returns the worktree path + the per-member branch name. */
async function seedMemberBranch(
  fix: Fixture,
  member: string,
  files: ReadonlyArray<{ name: string; body: string }>,
): Promise<{ wtPath: string; wtBranch: string }> {
  const wtBranch = `develop-${member}`;
  const wtPath = join(fix.atmuxDir, "worktrees", member);
  await mkdir(join(fix.atmuxDir, "worktrees"), { recursive: true });
  await provisionWorktree(fix.repoPath, "develop", wtBranch, wtPath);
  // Per-worktree git config so commits succeed under stock CI.
  await git(wtPath, ["config", "user.email", `${member}@example.com`]);
  await git(wtPath, ["config", "user.name", member]);
  for (const f of files) {
    await writeFile(join(wtPath, f.name), f.body);
    await git(wtPath, ["add", f.name]);
    await git(wtPath, ["commit", "-m", `${member}: ${f.name}`]);
  }
  return { wtPath, wtBranch };
}

async function readFlagsMd(fix: Fixture): Promise<string> {
  try {
    return await readFile(join(fix.atmuxDir, "flags.md"), "utf8");
  } catch {
    return "";
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

// ---------- Tests ----------

describe("e2e merger-fan-in (ADR-179 W8, t-7a7f0825)", () => {
  test("merge-cycle --dry-run lists 3 prospective merges; base + branches unchanged", async () => {
    await seedMemberBranch(fix, "alpha", [{ name: "alpha-1.md", body: "alpha\n" }]);
    await seedMemberBranch(fix, "bob", [{ name: "bob-1.md", body: "bob\n" }]);
    await seedMemberBranch(fix, "charlie", [
      { name: "charlie-1.md", body: "charlie\n" },
      { name: "charlie-2.md", body: "charlie 2\n" },
    ]);

    const baseShaBefore = await git(fix.repoPath, ["rev-parse", "develop"]);

    const logs: string[] = [];
    const rc = await mergeCycle(["--dry-run", "--team-dir", fix.repoPath], {
      log: (m) => {
        logs.push(m);
      },
    });
    expect(rc).toBe(0);
    const log = logs.join("");
    expect(log).toContain("would merge 3 branch(es)");
    expect(log).toContain("develop-alpha (1 commit(s) ahead)");
    expect(log).toContain("develop-bob (1 commit(s) ahead)");
    expect(log).toContain("develop-charlie (2 commit(s) ahead)");

    // No mutation: base SHA unchanged, all per-member branches still
    // point at their pre-cycle tip.
    const baseShaAfter = await git(fix.repoPath, ["rev-parse", "develop"]);
    expect(baseShaAfter).toBe(baseShaBefore);
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-alpha"])).toBe("1");
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-bob"])).toBe("1");
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-charlie"])).toBe("2");
  });

  test("merge-cycle --push lands 3 clean merges + base advances + origin receives push", async () => {
    await seedMemberBranch(fix, "alpha", [{ name: "alpha.md", body: "alpha\n" }]);
    await seedMemberBranch(fix, "bob", [{ name: "bob.md", body: "bob\n" }]);
    await seedMemberBranch(fix, "charlie", [{ name: "charlie.md", body: "charlie\n" }]);

    const baseShaBefore = await git(fix.repoPath, ["rev-parse", "develop"]);

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

    // Base advanced by ≥3 merge commits (each --no-ff merge adds at
    // least the source commit + a merge commit; allowing ≥3 covers
    // both fast-forward-impossible-with-no-ff and the per-source +
    // per-merge variants).
    const baseShaAfter = await git(fix.repoPath, ["rev-parse", "develop"]);
    expect(baseShaAfter).not.toBe(baseShaBefore);
    const newCommits = await git(fix.repoPath, [
      "rev-list",
      "--count",
      `${baseShaBefore}..${baseShaAfter}`,
    ]);
    expect(Number.parseInt(newCommits, 10)).toBeGreaterThanOrEqual(3);

    // Origin (the bare remote) received the push — `bareRemotePath`'s
    // HEAD on `main` should match `repoPath`'s post-cycle main SHA.
    const originSha = await git(fix.bareRemotePath, ["rev-parse", "develop"]);
    expect(originSha).toBe(baseShaAfter);

    // Every per-member branch is reachable from main → rev-list count
    // for `develop..main-<m>` is 0 after the merge.
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-alpha"])).toBe("0");
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-bob"])).toBe("0");
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-charlie"])).toBe("0");
  });

  test("conflict isolated to one member; siblings still merge; flag raised in flags.md", async () => {
    // alpha + bob both modify README.md's content → guaranteed conflict
    // when bob tries to merge after alpha lands (or vice versa,
    // depending on git enumeration order — branches sort
    // alphabetically with --list).
    await seedMemberBranch(fix, "alpha", [{ name: "README.md", body: "alpha's overwrite\n" }]);
    await seedMemberBranch(fix, "bob", [{ name: "README.md", body: "bob's overwrite\n" }]);
    // charlie touches a different file → no conflict.
    await seedMemberBranch(fix, "charlie", [{ name: "charlie.md", body: "charlie ok\n" }]);

    const logs: string[] = [];
    const rc = await mergeCycle(["--team-dir", fix.repoPath], {
      log: (m) => {
        logs.push(m);
      },
    });
    // Exit 1 because at least one conflict surfaced.
    expect(rc).toBe(1);
    const log = logs.join("");
    expect(log).toContain("conflicts: 1");
    expect(log).toMatch(/(develop-alpha|develop-bob).*README\.md/);

    // Two clean merges (alpha + charlie OR bob + charlie, depending
    // on enumeration; either way it's 2 merged + 1 conflict).
    expect(log).toContain("merged:    2");

    // Flag raised in flags.md with severity=high
    const flagsBody = await readFlagsMd(fix);
    expect(flagsBody).toContain("merger-conflict");
    expect(flagsBody).toContain("severity=high");
    expect(flagsBody).toContain("README.md");

    // Charlie's branch is still reachable from main (it landed).
    expect(await git(fix.repoPath, ["rev-list", "--count", "develop..develop-charlie"])).toBe("0");
  });

  test("doctor merger-branch-stale: backdated commit triggers yellow row", async () => {
    // Seed alpha first with a real commit, then add a backdated empty
    // commit on top so the per-branch tip's committer-date is >stale
    // (>24h ago by default). We use `Bun.spawn` directly here (not the
    // `git()` helper) so we can pass `GIT_COMMITTER_DATE` env —
    // `--date` alone sets author-date but the doctor probe reads
    // committer-date via `git log -1 --format=%ct`.
    const { wtPath } = await seedMemberBranch(fix, "alpha", [
      { name: "stale.md", body: "stale\n" },
    ]);
    const oldIso = new Date((Math.floor(Date.now() / 1000) - 8 * 24 * 3600) * 1000).toISOString();
    const proc = Bun.spawn({
      cmd: [
        "git",
        "-C",
        wtPath,
        "commit",
        "--allow-empty",
        "--date",
        oldIso,
        "-m",
        "backdated tip",
      ],
      env: {
        ...process.env,
        GIT_COMMITTER_DATE: oldIso,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`backdate commit failed: ${stderr}`);
    }

    const teamRaw = await readFile(join(fix.atmuxDir, "team.json"), "utf8");
    const team = JSON.parse(teamRaw) as Team;

    const rows = await checkMergerFanIn(team, fix.atmuxDir);
    const stale = rows.filter((r) => r.label.startsWith("merger:branch-stale"));
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale[0]?.status).toBe("yellow");
    expect(stale[0]?.label).toContain("alpha");
  });

  test("merger-branch-stale does NOT fire when commits are fresh (< stalenessHours)", async () => {
    await seedMemberBranch(fix, "alpha", [{ name: "fresh.md", body: "fresh\n" }]);
    const teamRaw = await readFile(join(fix.atmuxDir, "team.json"), "utf8");
    const team = JSON.parse(teamRaw) as Team;

    const rows = await checkMergerFanIn(team, fix.atmuxDir);
    const stale = rows.filter((r) => r.label.startsWith("merger:branch-stale"));
    expect(stale.length).toBe(0);
  });
});
