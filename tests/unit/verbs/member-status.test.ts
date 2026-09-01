// Unit tests for src/verbs/member.ts::memberStatusSet (ADR-260 §D3/§D4).
//
// `atmux member status <status>` — member self-reported status, the
// manual-orchestration-mode canonical verb. Staging mirrors
// tests/unit/verbs/claim.test.ts (real tmp `.atmux/` + team.json +
// SQLite-or-JSON kanban via addTask); output captured via the
// `opts.stdout` Writer seam, member resolution via `opts.env`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeartbeat } from "../../../src/core/heartbeat.ts";
import { addTask, claimTaskForMember, showTask } from "../../../src/core/kanban.ts";
import { readMemberStatus } from "../../../src/core/member-status.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { dispatchMemberSubverb, memberStatusSet } from "../../../src/verbs/member.ts";

let teamDir: string;
let atmuxDir: string;
let priorMember: string | undefined;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-member-status-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({
      name: "team",
      members: [{ name: "alpha" }, { name: "beta" }],
    }),
  );
  priorMember = process.env.ATMUX_MEMBER;
  delete process.env.ATMUX_MEMBER;
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
  if (priorMember !== undefined) process.env.ATMUX_MEMBER = priorMember;
  else delete process.env.ATMUX_MEMBER;
});

function run(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): { exec: () => Promise<number>; lines: string[] } {
  const lines: string[] = [];
  const exec = () =>
    memberStatusSet([...argv, "--team-dir", teamDir], {
      env,
      cwd: "/nowhere-relevant",
      stdout: (s: string) => {
        lines.push(s);
      },
    });
  return { exec, lines };
}

// ---------- Arg parsing ----------

describe("memberStatusSet — arg parsing", () => {
  test("status value required → UsageError", async () => {
    const { exec } = run(["--as", "alpha"]);
    await expect(exec()).rejects.toThrow(UsageError);
  });

  test("unknown status → UsageError naming the closed set", async () => {
    const { exec } = run(["vibing", "--as", "alpha"]);
    await expect(exec()).rejects.toThrow(/unknown status 'vibing'/);
  });

  test("unknown flag → UsageError", async () => {
    const { exec } = run(["idle", "--as", "alpha", "--frobnicate", "x"]);
    await expect(exec()).rejects.toThrow(UsageError);
  });

  test("extra positional → UsageError", async () => {
    const { exec } = run(["idle", "working", "--as", "alpha"]);
    await expect(exec()).rejects.toThrow(UsageError);
  });

  test("flag without value → UsageError", async () => {
    await expect(memberStatusSet(["idle", "--as"], {})).rejects.toThrow(UsageError);
  });
});

// ---------- Member resolution ----------

describe("memberStatusSet — member resolution", () => {
  test("--as wins; record written for that member", async () => {
    const { exec } = run(["idle", "--as", "alpha"]);
    expect(await exec()).toBe(0);
    expect((await readMemberStatus(atmuxDir, "alpha"))?.status).toBe("idle");
  });

  test("$ATMUX_MEMBER inferred when --as absent", async () => {
    const { exec } = run(["working"], { ATMUX_MEMBER: "beta" });
    expect(await exec()).toBe(0);
    expect((await readMemberStatus(atmuxDir, "beta"))?.status).toBe("working");
  });

  test("no --as, no env, no cwd match → UsageError", async () => {
    const { exec } = run(["idle"]);
    await expect(exec()).rejects.toThrow(/can't infer member/);
  });

  test("roster guard: --as names a non-member → ConfigError, no file minted", async () => {
    const { exec } = run(["idle", "--as", "ghost"]);
    await expect(exec()).rejects.toThrow(ConfigError);
    expect(await readMemberStatus(atmuxDir, "ghost")).toBe(null);
  });
});

// ---------- Status write + heartbeat ----------

describe("memberStatusSet — status write + heartbeat (ADR-260 §D3)", () => {
  test("writes the full record (note + taskId) and prints confirmation", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exec, lines } = run([
      "rate-limited",
      "--as",
      "alpha",
      "--note",
      "429 until 14:00",
      "--task",
      id,
    ]);
    expect(await exec()).toBe(0);
    const rec = await readMemberStatus(atmuxDir, "alpha");
    expect(rec?.status).toBe("rate-limited");
    expect(rec?.note).toBe("429 until 14:00");
    expect(rec?.taskId).toBe(id);
    expect(lines.join("")).toContain(`alpha status → rate-limited (${id})`);
  });

  test("touches the member's heartbeat (self-report = proof of liveness)", async () => {
    expect(await readHeartbeat(atmuxDir, "alpha")).toBe(null);
    const { exec } = run(["idle", "--as", "alpha"]);
    await exec();
    const hb = await readHeartbeat(atmuxDir, "alpha");
    expect(hb).not.toBe(null);
    expect(hb as number).toBeGreaterThan(0);
  });

  test("rate-limited --task records a reference WITHOUT transitioning the task", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exec } = run(["rate-limited", "--as", "alpha", "--task", id]);
    await exec();
    expect((await showTask(atmuxDir, id))?.status).toBe("todo");
  });

  test("--task naming a nonexistent task → ConfigError, status NOT written", async () => {
    const { exec } = run(["working", "--as", "alpha", "--task", "t-deadbeef"]);
    await expect(exec()).rejects.toThrow(/no such task/);
    expect(await readMemberStatus(atmuxDir, "alpha")).toBe(null);
  });
});

// ---------- Kanban coupling (ADR-260 §D4) ----------

describe("memberStatusSet — kanban coupling (ADR-260 §D4)", () => {
  test("working --task claims an unclaimed todo task (status + owner + claim line)", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exec, lines } = run(["working", "--as", "alpha", "--task", id]);
    expect(await exec()).toBe(0);
    const task = await showTask(atmuxDir, id);
    expect(task?.status).toBe("in-progress");
    expect(task?.owner).toBe("alpha");
    expect(lines.join("")).toContain(`alpha claimed ${id}`);
  });

  test("working --task on a task already mine → no re-claim, status still recorded", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await claimTaskForMember(atmuxDir, id, "alpha");
    const { exec, lines } = run(["working", "--as", "alpha", "--task", id]);
    expect(await exec()).toBe(0);
    expect(lines.join("")).not.toContain("claimed");
    expect((await readMemberStatus(atmuxDir, "alpha"))?.taskId).toBe(id);
  });

  test("working --task on a task in-progress under ANOTHER member → refused (race gate)", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await claimTaskForMember(atmuxDir, id, "beta");
    const { exec } = run(["working", "--as", "alpha", "--task", id]);
    await expect(exec()).rejects.toThrow();
    // Claim gate fired before the status write — no stale "working" record.
    expect(await readMemberStatus(atmuxDir, "alpha")).toBe(null);
  });

  test("blocked --task moves the task to blocked with the --note text", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exec, lines } = run([
      "blocked",
      "--as",
      "alpha",
      "--task",
      id,
      "--note",
      "waiting on reviewer",
    ]);
    expect(await exec()).toBe(0);
    const task = await showTask(atmuxDir, id);
    expect(task?.status).toBe("blocked");
    expect(task?.note).toBe("waiting on reviewer");
    expect(lines.join("")).toContain(`${id} → blocked`);
  });

  test("blocked --task without --note falls back to an attributed default note", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { exec } = run(["blocked", "--as", "alpha", "--task", id]);
    await exec();
    expect((await showTask(atmuxDir, id))?.note).toBe("blocked by alpha via member status");
  });

  test("idle with dangling in-progress tasks prints the atmux done reminder", async () => {
    const id = await addTask(atmuxDir, { subject: "finish the thing" });
    // Stage through the verb's own working-claim path so the inbox
    // mirror (movePendingToInProgress) is written too — loadInbox on
    // legacy-JSON teams reads the mirror, not the kanban directly.
    const stage = run(["working", "--as", "alpha", "--task", id]);
    await stage.exec();
    const { exec, lines } = run(["idle", "--as", "alpha"]);
    expect(await exec()).toBe(0);
    const out = lines.join("");
    expect(out).toContain("still owns 1 in-progress task");
    expect(out).toContain(`atmux done ${id}`);
  });

  test("idle with a clean slate prints no reminder", async () => {
    const { exec, lines } = run(["idle", "--as", "alpha"]);
    await exec();
    expect(lines.join("")).not.toContain("in-progress task");
  });
});

// ---------- Dispatcher routing ----------

describe("dispatchMemberSubverb — status routing", () => {
  test("'member status' routes to memberStatusSet with opts threaded", async () => {
    const lines: string[] = [];
    const rc = await dispatchMemberSubverb(
      ["status", "idle", "--as", "alpha", "--team-dir", teamDir],
      {
        env: {},
        cwd: "/nowhere-relevant",
        stdout: (s: string) => {
          lines.push(s);
        },
      },
    );
    expect(rc).toBe(0);
    expect(lines.join("")).toContain("alpha status → idle");
    expect((await readMemberStatus(atmuxDir, "alpha"))?.status).toBe("idle");
  });
});
