// Unit tests for src/verbs/dispatch.ts.
// Bash spec: lib/dispatch.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { loadInbox } from "../../../src/core/inbox.ts";
import { addTask, loadKanban } from "../../../src/core/kanban.ts";
import { pauseMember } from "../../../src/core/pause.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { buildDispatchPing, dispatch, parseDispatchArgs } from "../../../src/verbs/dispatch.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let priorTmux: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-dispatch-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-dispatch-team-"));
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
    // expected: server may already be gone
  }
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  await rm(socketDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
});

async function stageTeamWithMembers(members: ReadonlyArray<string>): Promise<{
  teamName: string;
  sessionName: string;
}> {
  const teamName = `${sessionPrefix}-team`;
  const sessionName = `atmux-${teamName}`;
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: teamName,
      members: members.map((name) => ({ name })),
    }),
  );
  // Stage a tmux session with one window per member so the ping path
  // (sendToMember) can find a target. First member becomes window 0.
  const first = members[0];
  if (first === undefined) throw new Error("test fail: ≥1 member");
  await tmux.session.newSession({
    name: sessionName,
    shellCommand: "cat",
    windowName: first,
  });
  for (const m of members.slice(1)) {
    await tmux.window.newWindow({ sessionName, name: m, shellCommand: "cat" });
  }
  await new Promise((r) => setTimeout(r, 80));
  return { teamName, sessionName };
}

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

// ---------- parseDispatchArgs ----------

describe("parseDispatchArgs", () => {
  test("plain <member> <id>", () => {
    expect(parseDispatchArgs(["alpha", "t-aaaaaaaa"])).toEqual({
      member: "alpha",
      id: "t-aaaaaaaa",
      noPing: false,
    });
  });

  test("--no-ping flag", () => {
    expect(parseDispatchArgs(["alpha", "t-x", "--no-ping"]).noPing).toBe(true);
  });

  test("--socket consumed", () => {
    expect(parseDispatchArgs(["alpha", "t-x", "--socket", "/tmp/s"]).socketPath).toBe("/tmp/s");
  });

  test("--team-dir consumed", () => {
    expect(parseDispatchArgs(["alpha", "t-x", "--team-dir", "/x"]).teamDir).toBe("/x");
  });

  test("missing member → UsageError", () => {
    expect(() => parseDispatchArgs([])).toThrow(UsageError);
  });

  test("missing id → UsageError", () => {
    expect(() => parseDispatchArgs(["alpha"])).toThrow(UsageError);
  });

  test("too many positionals → UsageError", () => {
    expect(() => parseDispatchArgs(["alpha", "t-x", "extra"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseDispatchArgs(["alpha", "t-x", "--bogus"])).toThrow(UsageError);
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseDispatchArgs(["alpha", "t-x", "--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseDispatchArgs(["alpha", "t-x", "--team-dir"])).toThrow(UsageError);
  });
});

// ---------- buildDispatchPing ----------

describe("buildDispatchPing", () => {
  test("includes id + subject lines + claim/done commands", () => {
    const out = buildDispatchPing({ id: "t-aaaaaaaa", subject: "hello", body: "" });
    expect(out).toContain("id: t-aaaaaaaa");
    expect(out).toContain("subject: hello");
    expect(out).toContain("Claim it with: atmux claim t-aaaaaaaa");
    expect(out).toContain("Mark done with: atmux done t-aaaaaaaa");
  });

  test("body block included when body is non-empty", () => {
    const out = buildDispatchPing({ id: "t-x", subject: "s", body: "details here" });
    expect(out).toContain("body:");
    expect(out).toContain("details here");
  });

  test("body block omitted when body is empty (bash conditional parity)", () => {
    const out = buildDispatchPing({ id: "t-x", subject: "s", body: "" });
    expect(out).not.toContain("body:");
  });
});

// ---------- dispatch verb integration ----------

describe("dispatch verb — integration", () => {
  test("happy path: kanban + inbox written, ping suppressed via --no-ping", async () => {
    await stageTeamWithMembers(["alpha"]);
    const id = await addTask(atmuxDir, { subject: "x" });
    const { stdout } = await captureStdoutStderr(() =>
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    );
    expect(stdout).toContain(`dispatched ${id} → alpha`);

    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.owner).toBe("alpha");
    expect(k.tasks[0]?.status).toBe("in-progress");
    expect(k.tasks[0]?.claimedAt).toBeGreaterThan(0);

    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toHaveLength(1);
    expect(inbox.inProgress[0]?.id).toBe(id);
    expect(inbox.inProgress[0]?.dispatchedAt).toBeGreaterThan(0);
  });

  test("happy path: ping fires when --no-ping not set; log written", async () => {
    await stageTeamWithMembers(["alpha"]);
    const id = await addTask(atmuxDir, { subject: "Ship feature X" });
    await captureStdoutStderr(() =>
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir]),
    );
    // sendToMember writes <atmuxDir>/logs/send-alpha.log on success.
    const logPath = join(atmuxDir, "logs", "send-alpha.log");
    const log = await Bun.file(logPath).text();
    expect(log).toContain("📨 NEW TASK");
    expect(log).toContain(id);
  });

  test("unknown member → ConfigError", async () => {
    await stageTeamWithMembers(["alpha"]);
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(
      dispatch(["bogus", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    ).rejects.toThrow(ConfigError);
  });

  test("paused member → ConfigError (refuse-paused parity)", async () => {
    await stageTeamWithMembers(["alpha"]);
    const id = await addTask(atmuxDir, { subject: "x" });
    await pauseMember(atmuxDir, "alpha", { reason: "manual" });
    try {
      await dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const ctx = (e as ConfigError).context as { what: string };
      expect(ctx.what).toContain("is paused");
      expect(ctx.what).toContain("atmux resume alpha");
    }
  });

  test("missing task id → ConfigError (claimTask propagates)", async () => {
    await stageTeamWithMembers(["alpha"]);
    await expect(
      dispatch(["alpha", "t-deadbeef", "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    ).rejects.toThrow(ConfigError);
  });

  test("unresolved deps → ConfigError (deps gate via claimTask)", async () => {
    await stageTeamWithMembers(["alpha"]);
    const dep = await addTask(atmuxDir, { subject: "dep" });
    const id = await addTask(atmuxDir, { subject: "x", deps: [dep] });
    await expect(
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    ).rejects.toThrow(ConfigError);
  });

  test("re-dispatch from owner A → member B drains A's inbox + warns on stderr (t-e452296b)", async () => {
    await stageTeamWithMembers(["alpha", "beta"]);
    const id = await addTask(atmuxDir, { subject: "x" });
    // First dispatch: alpha owns + has the task in inbox.inProgress.
    await captureStdoutStderr(() =>
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    );
    let alphaInbox = await loadInbox(atmuxDir, "alpha");
    expect(alphaInbox.inProgress.map((t) => t.id)).toEqual([id]);

    // Re-dispatch: beta picks up. alpha's inbox should be drained + a
    // warning surfaces on stderr.
    const { stderr, stdout } = await captureStdoutStderr(() =>
      dispatch(["beta", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    );
    expect(stdout).toContain(`dispatched ${id} → beta`);
    expect(stderr).toContain(`reassigning ${id} from alpha to beta`);

    alphaInbox = await loadInbox(atmuxDir, "alpha");
    const betaInbox = await loadInbox(atmuxDir, "beta");
    expect(alphaInbox.inProgress).toEqual([]);
    expect(betaInbox.inProgress.map((t) => t.id)).toEqual([id]);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.owner).toBe("beta");
  });

  test("re-dispatch to the SAME owner is a quiet idempotent re-claim (no warning)", async () => {
    await stageTeamWithMembers(["alpha"]);
    const id = await addTask(atmuxDir, { subject: "x" });
    await captureStdoutStderr(() =>
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    );
    const { stderr } = await captureStdoutStderr(() =>
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    );
    expect(stderr).not.toContain("reassigning");
  });

  test("first-time dispatch (no prior owner) does NOT emit a reassignment warning", async () => {
    await stageTeamWithMembers(["alpha"]);
    const id = await addTask(atmuxDir, { subject: "x" });
    const { stderr } = await captureStdoutStderr(() =>
      dispatch(["alpha", id, "--socket", socketPath, "--team-dir", teamDir, "--no-ping"]),
    );
    expect(stderr).not.toContain("reassigning");
  });

  test("ping failure does NOT abort the dispatch (warn + return 0)", async () => {
    // Stage team with member "ghost" that has NO tmux window — sendToMember
    // throws TmuxError, dispatch catches + warns + returns 0.
    await stageTeamWithMembers(["alpha"]);
    // Patch team.json post-stage: add `ghost` to the roster but
    // intentionally don't open a tmux window for them.
    const teamName = `${sessionPrefix}-team`;
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: teamName,
        members: [{ name: "alpha" }, { name: "ghost" }],
      }),
    );
    const id = await addTask(atmuxDir, { subject: "x" });
    const { result, stderr } = await captureStdoutStderr(() =>
      dispatch(["ghost", id, "--socket", socketPath, "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(stderr).toContain("dispatch: ping to ghost failed");
    // Kanban still updated.
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.owner).toBe("ghost");
  });
});
