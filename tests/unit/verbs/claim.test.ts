// Unit tests for src/verbs/claim.ts (claim + done shared module).
// Bash spec: lib/claim.sh @ worktree-frozen.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, loadKanban, moveTask } from "../../../src/core/kanban.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { TeamMember } from "../../../src/schema/team.ts";
import {
  appendDispatched,
  claim,
  done,
  loadInbox,
  parseClaimDoneArgs,
  pickMemberName,
} from "../../../src/verbs/claim.ts";

let teamDir: string;
let atmuxDir: string;
let priorMember: string | undefined;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-claim-verb-"));
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

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- parseClaimDoneArgs ----------

describe("parseClaimDoneArgs", () => {
  test("plain id", () => {
    expect(parseClaimDoneArgs(["t-aaaaaaaa"], "claim")).toEqual({ id: "t-aaaaaaaa" });
  });

  test("--as <who> consumed", () => {
    const a = parseClaimDoneArgs(["t-aaaaaaaa", "--as", "alpha"], "claim");
    expect(a.who).toBe("alpha");
  });

  test("--note <text> consumed (done verb)", () => {
    const a = parseClaimDoneArgs(["t-aaaaaaaa", "--note", "shipped"], "done");
    expect(a.note).toBe("shipped");
  });

  test("--team-dir <dir> consumed", () => {
    const a = parseClaimDoneArgs(["t-aaaaaaaa", "--team-dir", "/x"], "claim");
    expect(a.teamDir).toBe("/x");
  });

  test("missing id → UsageError", () => {
    expect(() => parseClaimDoneArgs([], "claim")).toThrow(UsageError);
  });

  test("--as without value → UsageError", () => {
    expect(() => parseClaimDoneArgs(["t-x", "--as"], "claim")).toThrow(UsageError);
  });

  test("--note without value → UsageError", () => {
    expect(() => parseClaimDoneArgs(["t-x", "--note"], "done")).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseClaimDoneArgs(["t-x", "--team-dir"], "claim")).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseClaimDoneArgs(["t-x", "--bogus"], "claim")).toThrow(UsageError);
  });

  test("too many positionals → UsageError", () => {
    expect(() => parseClaimDoneArgs(["t-x", "extra"], "claim")).toThrow(UsageError);
  });
});

// ---------- pickMemberName ----------

describe("pickMemberName", () => {
  const members: TeamMember[] = [{ name: "alpha", cwd: "/work/alpha" }, { name: "beta" }];

  test("--as wins over env + cwd", () => {
    const out = pickMemberName(
      { id: "t", who: "explicit" },
      { ATMUX_MEMBER: "envalpha" },
      "/work/alpha",
      members,
    );
    expect(out).toBe("explicit");
  });

  test("env wins over cwd when no --as", () => {
    const out = pickMemberName({ id: "t" }, { ATMUX_MEMBER: "envalpha" }, "/work/alpha", members);
    expect(out).toBe("envalpha");
  });

  test("cwd-match used when no --as / no env", () => {
    const out = pickMemberName({ id: "t" }, {}, "/work/alpha", members);
    expect(out).toBe("alpha");
  });

  test("returns undefined when nothing matches", () => {
    expect(pickMemberName({ id: "t" }, {}, "/elsewhere", members)).toBeUndefined();
  });

  test("empty --as falls through to env (bash treats empty as unset)", () => {
    const out = pickMemberName({ id: "t", who: "" }, { ATMUX_MEMBER: "envalpha" }, "/", members);
    expect(out).toBe("envalpha");
  });
});

// ---------- claim verb integration ----------

describe("claim verb — integration", () => {
  test("claim: assigns owner + status + writes inbox mirror", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const { out } = await captureStdout(() => claim([id, "--as", "alpha", "--team-dir", teamDir]));
    expect(out).toContain(`alpha claimed ${id}`);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.owner).toBe("alpha");
    expect(k.tasks[0]?.status).toBe("in-progress");
    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toHaveLength(1);
    expect(inbox.inProgress[0]?.id).toBe(id);
  });

  test("claim with $ATMUX_MEMBER infers member", async () => {
    process.env.ATMUX_MEMBER = "beta";
    const id = await addTask(atmuxDir, { subject: "x" });
    await captureStdout(() => claim([id, "--team-dir", teamDir]));
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.owner).toBe("beta");
  });

  test("claim with no --as / env / cwd-match → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(claim([id, "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("claim: deps not done → ConfigError (deps gate)", async () => {
    const dep = await addTask(atmuxDir, { subject: "dep" });
    const id = await addTask(atmuxDir, { subject: "x", deps: [dep] });
    await expect(claim([id, "--as", "alpha", "--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });

  test("claim: missing task id → ConfigError", async () => {
    await expect(claim(["t-deadbeef", "--as", "alpha", "--team-dir", teamDir])).rejects.toThrow(
      ConfigError,
    );
  });

  test("claim is idempotent on inbox.inProgress (bash claim.sh:92 parity)", async () => {
    // Prior dispatch already pushed the task to inbox.inProgress.
    // Member then runs `atmux claim` — kanban update happens, but
    // inbox shouldn't double-up.
    const id = await addTask(atmuxDir, { subject: "x" });
    const task = (await loadKanban(atmuxDir)).tasks[0];
    if (task === undefined) throw new Error("setup fail");
    await appendDispatched(atmuxDir, "alpha", task, 1);
    await captureStdout(() => claim([id, "--as", "alpha", "--team-dir", teamDir]));
    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.inProgress).toHaveLength(1);
  });
});

// ---------- done verb integration ----------

describe("done verb — integration", () => {
  test("done: marks task done + writes inbox mirror", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    const task = (await loadKanban(atmuxDir)).tasks[0];
    if (task === undefined) throw new Error("setup fail");
    await appendDispatched(atmuxDir, "alpha", task, 1);
    await moveTask(atmuxDir, id, "in-progress");
    const { out } = await captureStdout(() => done([id, "--as", "alpha", "--team-dir", teamDir]));
    expect(out).toContain(`alpha completed ${id}`);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks[0]?.status).toBe("done");
    expect(k.tasks[0]?.completedAt).toBeGreaterThan(0);
    const inbox = await loadInbox(atmuxDir, "alpha");
    expect(inbox.done).toHaveLength(1);
    expect(inbox.inProgress).toHaveLength(0);
  });

  test("done with --note persists note on the task", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await captureStdout(() =>
      done([id, "--as", "alpha", "--note", "shipped clean", "--team-dir", teamDir]),
    );
    const k = await loadKanban(atmuxDir);
    expect((k.tasks[0] as { note?: string }).note).toBe("shipped clean");
  });

  test("done: missing task id → ConfigError", async () => {
    await expect(done(["t-deadbeef", "--as", "alpha", "--team-dir", teamDir])).rejects.toThrow(
      ConfigError,
    );
  });

  test("done with no member inferable → UsageError", async () => {
    const id = await addTask(atmuxDir, { subject: "x" });
    await expect(done([id, "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });
});
