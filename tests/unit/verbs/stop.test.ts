// Unit tests for src/verbs/stop.ts.
// Bash spec: lib/stop.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { UsageError } from "../../../src/errors.ts";
import { archiveTimestamp, parseStopArgs, stop } from "../../../src/verbs/stop.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let priorTmux: string | undefined;
let priorNoCron: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-stop-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-stop-team-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  // ADR-083 follow-up: stop() now invokes cron-remove. Pin the test env
  // so the verb's internal ATMUX_NO_CRON gate short-circuits before it
  // can reach `crontab -l` / `crontab <file>` — keeps the host
  // crontab untouched across the suite. Tests that deliberately
  // exercise the cron-remove path use the StopOpts.cronRemoveFn DI.
  priorNoCron = process.env.ATMUX_NO_CRON;
  process.env.ATMUX_NO_CRON = "1";
  tmux = createTmux({ socketPath, configFile: "/dev/null" });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: idempotent teardown
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  if (priorNoCron !== undefined) process.env.ATMUX_NO_CRON = priorNoCron;
  else delete process.env.ATMUX_NO_CRON;
  await rm(socketDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdoutStderr<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const o1 = process.stdout.write.bind(process.stdout);
  const o2 = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string | Uint8Array) => {
    stdout += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    stderr += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = o1;
    process.stderr.write = o2;
  }
}

async function stageTeamWithSession(members: ReadonlyArray<string>): Promise<{
  teamName: string;
  sessionName: string;
}> {
  const teamName = `${sessionPrefix}-team`;
  const sessionName = `atmux-${teamName}`;
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: teamName, members: members.map((name) => ({ name })) }),
  );
  const first = members[0];
  if (first === undefined) throw new Error("test fail");
  await tmux.session.newSession({ name: sessionName, shellCommand: "cat", windowName: first });
  for (const m of members.slice(1)) {
    await tmux.window.newWindow({ sessionName, name: m, shellCommand: "cat" });
  }
  await new Promise((r) => setTimeout(r, 80));
  return { teamName, sessionName };
}

// ---------- Pure: parseStopArgs ----------

describe("parseStopArgs", () => {
  test("empty argv → defaults", () => {
    expect(parseStopArgs([])).toEqual({ force: false, archive: true });
  });

  test("--force / -f sets force=true", () => {
    expect(parseStopArgs(["--force"]).force).toBe(true);
    expect(parseStopArgs(["-f"]).force).toBe(true);
  });

  test("--no-archive sets archive=false", () => {
    expect(parseStopArgs(["--no-archive"]).archive).toBe(false);
  });

  test("--socket consumed", () => {
    expect(parseStopArgs(["--socket", "/tmp/s"]).socketPath).toBe("/tmp/s");
  });

  test("--team-dir consumed", () => {
    expect(parseStopArgs(["--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseStopArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseStopArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseStopArgs(["bogus"])).toThrow(UsageError);
  });
});

// ---------- Pure: archiveTimestamp ----------

describe("archiveTimestamp — bash date -u +%Y%m%dT%H%M%SZ parity", () => {
  test("formats UTC epoch with Z suffix", () => {
    // 2026-01-15T12:34:56Z → 1768523696000ms
    const epoch = Date.UTC(2026, 0, 15, 12, 34, 56);
    expect(archiveTimestamp(epoch)).toBe("20260115T123456Z");
  });

  test("zero-pads month/day/hour/minute/second", () => {
    const epoch = Date.UTC(2026, 0, 1, 1, 2, 3);
    expect(archiveTimestamp(epoch)).toBe("20260101T010203Z");
  });
});

// ---------- Integration ----------

describe("stop verb — integration", () => {
  test("session does not exist → warn + return 0", async () => {
    // Stage team.json but DON'T create a tmux session.
    const teamName = `${sessionPrefix}-team`;
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({ name: teamName, members: [{ name: "alpha" }] }),
    );
    const { result, stderr } = await captureStdoutStderr(() =>
      stop(["--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(stderr).toContain("does not exist");
  });

  test("--force kills session immediately + archives state", async () => {
    const { sessionName } = await stageTeamWithSession(["alpha"]);
    await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');
    const { result, stdout } = await captureStdoutStderr(() =>
      stop(["--force", "--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(stdout).toContain(`session ${sessionName} stopped`);
    expect(await tmux.session.hasSession(`=${sessionName}`)).toBe(false);
    // Archive dir created with one timestamped sub-dir.
    const archives = await readdir(join(atmuxDir, "archive"));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  test("--no-archive skips state copy", async () => {
    await stageTeamWithSession(["alpha"]);
    await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');
    await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir]),
    );
    // archive dir does NOT exist (or is empty if pre-existing).
    let archives: string[] = [];
    try {
      archives = await readdir(join(atmuxDir, "archive"));
    } catch {
      // expected: archive dir doesn't exist
    }
    expect(archives).toHaveLength(0);
  });

  test("non-force path sends C-c then kills (graceful)", async () => {
    // The C-c send is to each member's window. cat process catches
    // SIGINT and exits, but the window stays alive (tmux respawns
    // shell). Then sleep(2s), then kill-session. We assert post-state.
    const { sessionName } = await stageTeamWithSession(["alpha"]);
    const { result } = await captureStdoutStderr(() =>
      stop(["--no-archive", "--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(await tmux.session.hasSession(`=${sessionName}`)).toBe(false);
  }, 10_000);

  test("archive copies inboxes + kanban + driver-inbox", async () => {
    await stageTeamWithSession(["alpha"]);
    // Stage a real inbox + kanban + driver-inbox to copy.
    await mkdir(join(atmuxDir, "inboxes"), { recursive: true });
    await writeFile(
      join(atmuxDir, "inboxes", "alpha.json"),
      '{"pending":[],"inProgress":[],"done":[]}',
    );
    await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');
    await writeFile(join(atmuxDir, "driver-inbox.md"), "# inbox\n");

    await captureStdoutStderr(() =>
      stop(["--force", "--socket", socketPath, "--team-dir", teamDir]),
    );

    const archives = await readdir(join(atmuxDir, "archive"));
    const ts = archives[0];
    if (ts === undefined) throw new Error("test fail: no archive");
    const destInboxes = await readdir(join(atmuxDir, "archive", ts, "inboxes"));
    expect(destInboxes).toContain("alpha.json");
    const destKanban = await Bun.file(join(atmuxDir, "archive", ts, "kanban.json")).text();
    expect(destKanban).toContain("tasks");
    const destDriver = await Bun.file(join(atmuxDir, "archive", ts, "driver-inbox.md")).text();
    expect(destDriver).toContain("inbox");
  });

  // ADR-083 follow-up: stop() fires cron-remove inline (bash lib/stop.sh:115
  // parity). Confirm via the StopOpts.cronRemoveFn DI seam — the suite's
  // beforeEach pins ATMUX_NO_CRON=1 to keep the host crontab off-limits,
  // but the DI lets us observe that the call actually happened.
  test("ADR-083: stop() invokes cron-remove via DI with --quiet (+--team-dir when set)", async () => {
    await stageTeamWithSession(["alpha"]);
    let invocations: ReadonlyArray<string>[] = [];
    const cronRemoveFn = async (argv: ReadonlyArray<string>) => {
      invocations = [...invocations, argv];
      return 0;
    };
    await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        cronRemoveFn,
      }),
    );
    expect(invocations.length).toBe(1);
    expect(invocations[0]).toContain("--quiet");
    // teamDir was passed → propagated downstream so the verb resolves
    // the same team root that stop just shut down.
    expect(invocations[0]).toContain("--team-dir");
    expect(invocations[0]).toContain(teamDir);
  });

  test("ADR-083: cron-remove failure does NOT abort stop (non-fatal)", async () => {
    await stageTeamWithSession(["alpha"]);
    const cronRemoveFn = async (_argv: ReadonlyArray<string>) => {
      throw new Error("simulated cron-remove blow-up");
    };
    const { result, stderr } = await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        cronRemoveFn,
      }),
    );
    expect(result).toBe(0);
    expect(stderr).toContain("cron-remove fell through");
    expect(stderr).toContain("simulated cron-remove blow-up");
  });

  // ---------- ADR-082 W4 worktree-prune integration ----------

  type GitSpawn = import("../../../src/abstractions/worktree.ts").GitSpawn;
  type SpawnResult = import("../../../src/abstractions/spawn.ts").SpawnResult;

  function gitOk(stdout = ""): SpawnResult {
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      argv: [],
      cmd: "git",
      signalled: null,
      durationMs: 0,
    };
  }
  function gitFail(stderr: string, code = 128): SpawnResult {
    return { exitCode: code, stdout: "", stderr, argv: [], cmd: "git", signalled: null, durationMs: 0 };
  }

  /** Stage a worktreeIsolation:true team WITH session + materialise each
   *  member's worktree dir on disk (so `pruneWorktree`'s `exists()`
   *  check resolves to true and proceeds to the dirty check). */
  async function stageWorktreeTeam(members: ReadonlyArray<string>): Promise<{
    teamName: string;
    sessionName: string;
    worktreePaths: Record<string, string>;
  }> {
    const teamName = `${sessionPrefix}-team`;
    const sessionName = `atmux-${teamName}`;
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: teamName,
        members: members.map((name) => ({ name })),
        worktreeIsolation: true,
      }),
    );
    const first = members[0];
    if (first === undefined) throw new Error("test fail");
    await tmux.session.newSession({ name: sessionName, shellCommand: "cat", windowName: first });
    for (const m of members.slice(1)) {
      await tmux.window.newWindow({ sessionName, name: m, shellCommand: "cat" });
    }
    // Materialise each member's worktree directory. The test fixture's
    // atmuxDir is `<teamDir>/.atmux` (regex DOES strip the suffix →
    // projectRoot = teamDir), so resolveWorktreePath joins
    // `<projectRoot>/.atmux/worktrees/<member>` which equals
    // `<atmuxDir>/worktrees/<member>` — co-located with the rest of
    // .atmux/ state.
    const worktreePaths: Record<string, string> = {};
    for (const m of members) {
      const wt = join(atmuxDir, "worktrees", m);
      await mkdir(wt, { recursive: true });
      worktreePaths[m] = wt;
    }
    await new Promise((r) => setTimeout(r, 80));
    return { teamName, sessionName, worktreePaths };
  }

  test("--force + worktreeIsolation=true + clean worktree → prunes via `git worktree remove`", async () => {
    await stageWorktreeTeam(["alpha"]);
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      // rev-parse returns a fake repo path; status returns clean; remove
      // succeeds. The actual filesystem `git worktree remove` would also
      // delete the directory, but the mock is content-only — we don't
      // assert the wt dir is gone in this test (the abstraction's own
      // tests pin that).
      if (argv.includes("rev-parse")) return gitOk("/srv/fake-repo\n");
      if (argv.includes("status")) return gitOk("");
      return gitOk("");
    };
    const { result, stdout } = await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        gitSpawn,
      }),
    );
    expect(result).toBe(0);
    // git was invoked: 1× rev-parse + 1× status + 1× worktree remove.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.some((c) => c.includes("rev-parse"))).toBe(true);
    expect(calls.some((c) => c.includes("status"))).toBe(true);
    expect(calls.some((c) => c.includes("remove"))).toBe(true);
    expect(stdout).toContain("worktree: pruned 1/1");
  });

  test("--force + dirty worktree → SKIPS prune, warns, leaves worktree for operator", async () => {
    await stageWorktreeTeam(["alpha"]);
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return gitOk("/srv/fake-repo\n");
      // status returns a dirty entry → pruneWorktree returns
      // {pruned: false, reason: 'dirty'}.
      if (argv.includes("status")) return gitOk(" M src/foo.ts\n");
      return gitOk("");
    };
    const { result, stdout, stderr } = await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        gitSpawn,
      }),
    );
    expect(result).toBe(0);
    // No `worktree remove` invocation — the dirty-skip preempts it.
    expect(calls.some((c) => c.includes("remove"))).toBe(false);
    // Summary surfaces 0 pruned + 1 dirty.
    expect(stdout).toContain("worktree: pruned 0/1");
    expect(stdout).toContain("1 dirty");
    // Per-member warning names the dirty member specifically.
    expect(stderr).toContain("worktree alpha dirty");
  });

  test("--force + worktreeIsolation=false (legacy) → ZERO git invocations", async () => {
    // Legacy stop path — gate at team.worktreeIsolation !== true MUST
    // short-circuit before any git work.
    await stageTeamWithSession(["alpha"]);
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      return gitOk("");
    };
    const { result } = await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        gitSpawn,
      }),
    );
    expect(result).toBe(0);
    expect(calls).toEqual([]);
  });

  test("`atmux stop` (no --force) + worktreeIsolation=true → ZERO git invocations (worktrees survive)", async () => {
    // Per task body: "atmux stop (no --force) does NOT prune.
    // Worktrees survive normal stop+start cycles." Pin the gate so a
    // future regression that drops the `parsed.force` check shows up.
    await stageWorktreeTeam(["alpha"]);
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      return gitOk("");
    };
    const { result } = await captureStdoutStderr(() =>
      stop(["--no-archive", "--socket", socketPath, "--team-dir", teamDir], { gitSpawn }),
    );
    expect(result).toBe(0);
    expect(calls).toEqual([]);
  }, 10_000);

  test("idempotence: already-removed worktree directory → {pruned:false, reason:'missing'} (no-op, no error)", async () => {
    // Stage the team metadata + tmux session but DELETE the worktree
    // dirs before stop runs. pruneWorktree's missing-path short-circuit
    // means git is never invoked for missing members.
    const { worktreePaths } = await stageWorktreeTeam(["alpha"]);
    await rm(worktreePaths.alpha as string, { recursive: true, force: true });
    const calls: ReadonlyArray<string>[] = [];
    const gitSpawn: GitSpawn = async (argv) => {
      calls.push(argv);
      if (argv.includes("rev-parse")) return gitOk("/srv/fake-repo\n");
      return gitOk("");
    };
    const { result, stdout } = await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        gitSpawn,
      }),
    );
    expect(result).toBe(0);
    // rev-parse fires (the gate ran). status + remove do NOT —
    // pruneWorktree skipped both due to missing path.
    expect(calls.some((c) => c.includes("rev-parse"))).toBe(true);
    expect(calls.some((c) => c.includes("status"))).toBe(false);
    expect(calls.some((c) => c.includes("remove"))).toBe(false);
    // Summary counts the missing member.
    expect(stdout).toContain("1 already gone");
  });

  test("git rev-parse failure → warn + skip prune, killSession still fires", async () => {
    const { sessionName } = await stageWorktreeTeam(["alpha"]);
    const gitSpawn: GitSpawn = async (argv) => {
      if (argv.includes("rev-parse")) return gitFail("fatal: not a git repository");
      return gitOk("");
    };
    const { result, stderr } = await captureStdoutStderr(() =>
      stop(["--force", "--no-archive", "--socket", socketPath, "--team-dir", teamDir], {
        gitSpawn,
      }),
    );
    expect(result).toBe(0);
    expect(stderr).toContain("worktree-prune skipped");
    expect(stderr).toContain("cannot detect repo root");
    // The session still got killed — the warning didn't wedge stop.
    expect(await tmux.session.hasSession(`=${sessionName}`)).toBe(false);
  });

});
