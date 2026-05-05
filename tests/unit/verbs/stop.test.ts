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
  tmux = createTmux({ socketPath, configFile: "/dev/null" });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: idempotent teardown
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
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
      stop([
        "--force",
        "--no-archive",
        "--socket",
        socketPath,
        "--team-dir",
        teamDir,
      ]),
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
    const destKanban = await Bun.file(
      join(atmuxDir, "archive", ts, "kanban.json"),
    ).text();
    expect(destKanban).toContain("tasks");
    const destDriver = await Bun.file(
      join(atmuxDir, "archive", ts, "driver-inbox.md"),
    ).text();
    expect(destDriver).toContain("inbox");
  });
});
