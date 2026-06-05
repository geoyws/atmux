// Unit tests for `atmux claim --next --role <X>` — ADR-210 Tier-2 §73
// role-tag filter (Task t-f6659897, slice S6). The `--role` flag turns
// the auto-select path into a HARD lane filter: only Tasks whose
// `.lane === role` are eligible, regardless of the member's own lane or
// `crossLaneClaim`. A mismatch (no eligible Task in that role) is a
// no-op, NOT a cross-lane fallback.
//
// Acceptance (Task body):
//   - claim --next --role fe → only FE-lane tickets
//   - claim --next --role be → only BE-lane tickets
//   - fe member with --role be → no ticket claimed (filter holds)
//   - backward compat: no --role → existing lane-agnostic behavior

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, loadKanban } from "../../../src/core/kanban.ts";
import { UsageError } from "../../../src/errors.ts";
import { claim, loadInbox, parseClaimDoneArgs } from "../../../src/verbs/claim.ts";

let teamDir: string;
let atmuxDir: string;
let priorMember: string | undefined;

async function seedTeam(members: Array<{ name: string; lane?: string }>): Promise<void> {
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "team", members }));
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-claim-role-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
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

// ---------- parseClaimDoneArgs --role ----------

describe("parseClaimDoneArgs --role", () => {
  test("--next --role fe → role captured", () => {
    const a = parseClaimDoneArgs(["--next", "--role", "fe"], "claim");
    expect(a.next).toBe(true);
    expect(a.role).toBe("fe");
  });

  test("order-independent: --role before --next", () => {
    const a = parseClaimDoneArgs(["--role", "be", "--next"], "claim");
    expect(a.next).toBe(true);
    expect(a.role).toBe("be");
  });

  test("--role without value → UsageError", () => {
    expect(() => parseClaimDoneArgs(["--next", "--role"], "claim")).toThrow(UsageError);
  });

  test("--role without --next → UsageError (only valid with auto-select)", () => {
    expect(() => parseClaimDoneArgs(["t-deadbeef", "--role", "fe"], "claim")).toThrow(UsageError);
  });

  test("--role on done verb → UsageError", () => {
    expect(() => parseClaimDoneArgs(["--role", "fe"], "done")).toThrow(UsageError);
  });

  test("no --role → role undefined (backward compat)", () => {
    const a = parseClaimDoneArgs(["--next"], "claim");
    expect(a.role).toBeUndefined();
  });
});

// ---------- claim --next --role verb integration ----------

describe("claim --next --role — integration", () => {
  test("--role fe claims only the FE-lane ticket, never the BE one", async () => {
    await seedTeam([{ name: "worker", lane: "fe" }]);
    const beId = await addTask(atmuxDir, { subject: "be job", lane: "be", priority: 1 });
    const feId = await addTask(atmuxDir, { subject: "fe job", lane: "fe", priority: 5 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--role", "fe", "--as", "worker", "--team-dir", teamDir]),
    );
    // BE ticket has the better priority (1 < 5) but must be filtered out.
    expect(out).toContain(`worker claimed ${feId}`);
    expect(out).not.toContain(beId);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === feId)?.owner).toBe("worker");
    expect(k.tasks.find((t) => t.id === feId)?.status).toBe("in-progress");
    // BE ticket untouched.
    expect(k.tasks.find((t) => t.id === beId)?.owner).toBeNull();
    expect(k.tasks.find((t) => t.id === beId)?.status).toBe("todo");
    const inbox = await loadInbox(atmuxDir, "worker");
    expect(inbox.inProgress.map((t) => t.id)).toContain(feId);
  });

  test("--role be claims only the BE-lane ticket", async () => {
    await seedTeam([{ name: "worker", lane: "be" }]);
    const feId = await addTask(atmuxDir, { subject: "fe job", lane: "fe", priority: 1 });
    const beId = await addTask(atmuxDir, { subject: "be job", lane: "be", priority: 5 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--role", "be", "--as", "worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(`worker claimed ${beId}`);
    expect(out).not.toContain(feId);
  });

  test("fe member with --role be → claims nothing (no BE work) → no-op exit 0", async () => {
    await seedTeam([{ name: "fe-worker", lane: "fe" }]);
    // Only FE + lane-less work exists; --role be must find nothing.
    const feId = await addTask(atmuxDir, { subject: "fe job", lane: "fe", priority: 1 });
    const noLaneId = await addTask(atmuxDir, { subject: "misc", priority: 1 });
    const { out, result } = await captureStdout(() =>
      claim(["--next", "--role", "be", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(out).toBe("");
    // Nothing claimed.
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === feId)?.status).toBe("todo");
    expect(k.tasks.find((t) => t.id === noLaneId)?.status).toBe("todo");
  });

  test("fe member CAN claim a BE ticket via --role be (role overrides member lane)", async () => {
    await seedTeam([{ name: "fe-worker", lane: "fe" }]);
    const beId = await addTask(atmuxDir, { subject: "be job", lane: "be", priority: 1 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--role", "be", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(`fe-worker claimed ${beId}`);
  });

  test("--role does NOT fall back to lane-less tickets", async () => {
    await seedTeam([{ name: "worker", lane: "fe" }]);
    // No FE-lane work; only a lane-less ticket. --role fe must NOT grab it.
    const noLaneId = await addTask(atmuxDir, { subject: "misc", priority: 1 });
    const { out, result } = await captureStdout(() =>
      claim(["--next", "--role", "fe", "--as", "worker", "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(out).toBe("");
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === noLaneId)?.status).toBe("todo");
  });

  test("backward compat: no --role keeps lane-agnostic fallback behavior", async () => {
    await seedTeam([{ name: "worker", lane: "fe" }]);
    // No FE work; lane-less ticket exists. Without --role, default
    // crossLaneClaim=true means the lane=null fallback applies.
    const noLaneId = await addTask(atmuxDir, { subject: "misc", priority: 1 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--as", "worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(`worker claimed ${noLaneId}`);
  });

  test("--role respects deps-gating + priority tiebreak within the role", async () => {
    await seedTeam([{ name: "worker", lane: "fe" }]);
    const blocker = await addTask(atmuxDir, { subject: "fe blocker", lane: "fe", priority: 9 });
    // Higher-priority FE task is dep-blocked; must be skipped for the blocker.
    await addTask(atmuxDir, {
      subject: "fe blocked",
      lane: "fe",
      deps: [blocker],
      priority: 1,
    });
    const { out } = await captureStdout(() =>
      claim(["--next", "--role", "fe", "--as", "worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(`worker claimed ${blocker}`);
  });
});
