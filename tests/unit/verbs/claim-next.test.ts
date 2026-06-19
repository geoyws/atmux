// Unit tests for `atmux claim --next` — ADR-062 §1 lane-aware pull
// (Task t-290281fa, R1-T1). Six AC fold-ins per the Task body:
//   1. own-lane match
//   2. deps-blocked skip
//   3. lane=null fallback
//   4. strict=true refusal (crossLaneClaim=false)
//   5. no-match no-op exit
//   6. multi-eligible priority+createdAt tiebreak

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, loadKanban, moveTask, selectNextClaimable } from "../../../src/core/kanban.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import type { KanbanTask } from "../../../src/schema/kanban.ts";
import { claim, parseClaimDoneArgs } from "../../../src/verbs/claim.ts";

let teamDir: string;
let atmuxDir: string;
let priorMember: string | undefined;

interface SeedTeamOpts {
  feLane?: boolean;
  beLane?: boolean;
  laneless?: boolean;
  crossLaneClaim?: boolean;
}

async function seedTeam(opts: SeedTeamOpts = {}): Promise<void> {
  const members: Array<{ name: string; lane?: string }> = [];
  if (opts.feLane !== false) members.push({ name: "fe-worker", lane: "fe" });
  if (opts.beLane === true) members.push({ name: "be-worker", lane: "be" });
  if (opts.laneless === true) members.push({ name: "drifter" });
  const team: Record<string, unknown> = {
    name: "team",
    members,
  };
  if (opts.crossLaneClaim !== undefined) {
    team.kanban = { crossLaneClaim: opts.crossLaneClaim };
  }
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
}

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-claim-next-"));
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

// ---------- parseClaimDoneArgs --next ----------

describe("parseClaimDoneArgs --next", () => {
  test("--next without id → next=true, id empty", () => {
    const a = parseClaimDoneArgs(["--next"], "claim");
    expect(a.next).toBe(true);
    expect(a.id).toBe("");
  });

  test("--next with --as", () => {
    const a = parseClaimDoneArgs(["--next", "--as", "fe-worker"], "claim");
    expect(a.next).toBe(true);
    expect(a.who).toBe("fe-worker");
  });

  test("--next + positional id → UsageError (selection is automatic)", () => {
    expect(() => parseClaimDoneArgs(["--next", "t-deadbeef"], "claim")).toThrow(UsageError);
  });

  test("--next on done verb → UsageError", () => {
    expect(() => parseClaimDoneArgs(["--next"], "done")).toThrow(UsageError);
  });
});

// ---------- selectNextClaimable (pure) ----------

describe("selectNextClaimable", () => {
  const baseTask = (over: Partial<KanbanTask>): KanbanTask => ({
    id: "t-x",
    subject: "x",
    body: "",
    status: "todo",
    owner: null,
    deps: [],
    priority: null,
    lane: null,
    createdAt: 1000,
    claimedAt: null,
    completedAt: null,
    ...over,
  });

  test("AC1: own-lane match wins over lane=null when both eligible", () => {
    const tasks = [
      baseTask({ id: "t-fe", lane: "fe", priority: 5, createdAt: 1000 }),
      baseTask({ id: "t-noLane", lane: null, priority: 1, createdAt: 1000 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    expect(pick?.id).toBe("t-fe");
  });

  test("AC2: deps-blocked task is skipped", () => {
    const tasks = [
      baseTask({ id: "t-blocker", lane: "fe", status: "todo" }),
      baseTask({ id: "t-blocked", lane: "fe", deps: ["t-blocker"], priority: 1 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    // priority-1 t-blocked is blocked; priority-null t-blocker is the only eligible.
    expect(pick?.id).toBe("t-blocker");
  });

  test("AC3: lane=null fallback when own-lane dry + crossLaneClaim=true", () => {
    const tasks = [
      baseTask({ id: "t-be", lane: "be", priority: 1 }),
      baseTask({ id: "t-noLane", lane: null, priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    // own-lane=fe is dry; cross-lane fallback picks lane=null (NOT t-be).
    expect(pick?.id).toBe("t-noLane");
  });

  test("AC4: crossLaneClaim=false suppresses fallback (returns null)", () => {
    const tasks = [
      baseTask({ id: "t-be", lane: "be", priority: 1 }),
      baseTask({ id: "t-noLane", lane: null, priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: false,
      caller: "fe-worker",
    });
    expect(pick).toBeNull();
  });

  test("AC5: no eligible Tasks → null (no-op)", () => {
    const tasks = [baseTask({ id: "t-1", status: "done", lane: "fe" })];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    expect(pick).toBeNull();
  });

  test("AC6: tie-break — priority asc, then createdAt asc", () => {
    const tasks = [
      baseTask({ id: "t-late", lane: "fe", priority: 2, createdAt: 2000 }),
      baseTask({ id: "t-early", lane: "fe", priority: 2, createdAt: 1000 }),
      baseTask({ id: "t-low", lane: "fe", priority: 5, createdAt: 500 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    // priority=2 wins over priority=5; among tied priority, oldest createdAt wins.
    expect(pick?.id).toBe("t-early");
  });

  test("null priority sorts last (treated as 999)", () => {
    const tasks = [
      baseTask({ id: "t-explicit", lane: "fe", priority: 3 }),
      baseTask({ id: "t-implicit", lane: "fe", priority: null }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    expect(pick?.id).toBe("t-explicit");
  });

  test("owner-gate: pre-assigned-to-self stays claimable", () => {
    const tasks = [
      baseTask({ id: "t-mine", lane: "fe", owner: "fe-worker", priority: 1 }),
      baseTask({ id: "t-other", lane: "fe", owner: "be-worker", priority: 1 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
    });
    expect(pick?.id).toBe("t-mine");
  });

  test("lane-less caller goes straight to lane=null fallback", () => {
    const tasks = [
      baseTask({ id: "t-fe", lane: "fe", priority: 1 }),
      baseTask({ id: "t-noLane", lane: null, priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: null,
      crossLaneClaim: true,
      caller: "drifter",
    });
    expect(pick?.id).toBe("t-noLane");
  });

  // ADR-033 driver-only refuse-gate — auto-pickup filter.
  // Failure surfaced by t-25edd0f7 dogfooding: schema field existed
  // but selection ignored it, so members could auto-claim driverOnly
  // Tasks (the precise bug ADR-033 was written to prevent).
  test("ADR-033: driverOnly=true Task invisible to default (member) scope", () => {
    const tasks = [
      baseTask({ id: "t-driverOnly", lane: null, priority: 1, driverOnly: true }),
      baseTask({ id: "t-regular", lane: null, priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: null,
      crossLaneClaim: true,
      caller: "worker",
    });
    // No callerScope passed → default member treatment, driverOnly invisible.
    expect(pick?.id).toBe("t-regular");
  });

  test("ADR-033: callerScope='member' explicitly hides driverOnly Tasks", () => {
    const tasks = [baseTask({ id: "t-driverOnly", lane: null, driverOnly: true })];
    const pick = selectNextClaimable(tasks, {
      callerLane: null,
      crossLaneClaim: true,
      caller: "worker",
      callerScope: "member",
    });
    expect(pick).toBeNull();
  });

  test("ADR-033: callerScope='driver' restores visibility", () => {
    const tasks = [baseTask({ id: "t-driverOnly", lane: null, driverOnly: true })];
    const pick = selectNextClaimable(tasks, {
      callerLane: null,
      crossLaneClaim: true,
      caller: "driver",
      callerScope: "driver",
    });
    expect(pick?.id).toBe("t-driverOnly");
  });

  test("ADR-033: driverOnly hides Task in own-lane first pass too", () => {
    const tasks = [
      baseTask({ id: "t-fe-driverOnly", lane: "fe", priority: 1, driverOnly: true }),
      baseTask({ id: "t-fe-regular", lane: "fe", priority: 5 }),
    ];
    const pick = selectNextClaimable(tasks, {
      callerLane: "fe",
      crossLaneClaim: true,
      caller: "fe-worker",
      callerScope: "member",
    });
    expect(pick?.id).toBe("t-fe-regular");
  });
});

// ---------- claim --next verb integration ----------

describe("claim --next verb — integration", () => {
  // ADR-263: claim --next is feed-only — it flips the kanban task to
  // in-progress + stamps the owner, and does NOT mirror into a per-member
  // inbox (the fleet-coordination inbox mirror was cut). Assert the real
  // kanban transition only.
  test("AC1: own-lane match → kanban task flipped to in-progress + owner set", async () => {
    await seedTeam({ feLane: true });
    const id = await addTask(atmuxDir, { subject: "fe job", lane: "fe", priority: 1 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(`fe-worker claimed ${id}`);
    const k = await loadKanban(atmuxDir);
    const claimed = k.tasks.find((t) => t.id === id);
    expect(claimed?.owner).toBe("fe-worker");
    expect(claimed?.status).toBe("in-progress");
  });

  test("AC2: deps-blocked task is skipped, eligible sibling is picked", async () => {
    await seedTeam({ feLane: true });
    const blocker = await addTask(atmuxDir, { subject: "blocker", lane: "fe" });
    const blocked = await addTask(atmuxDir, {
      subject: "blocked",
      lane: "fe",
      deps: [blocker],
      priority: 1,
    });
    const { out } = await captureStdout(() =>
      claim(["--next", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(blocker);
    expect(out).not.toContain(blocked);
  });

  test("AC3: own-lane dry + crossLaneClaim=true (default) → lane=null fallback", async () => {
    await seedTeam({ feLane: true, beLane: true });
    // BE-lane task exists; FE worker should NOT cross into it.
    await addTask(atmuxDir, { subject: "be job", lane: "be", priority: 1 });
    const noLaneId = await addTask(atmuxDir, { subject: "misc", priority: 5 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(`fe-worker claimed ${noLaneId}`);
  });

  test("AC4: crossLaneClaim=false + no own-lane work → ConfigError refusal", async () => {
    await seedTeam({ feLane: true, crossLaneClaim: false });
    await addTask(atmuxDir, { subject: "misc", priority: 1 });
    await expect(claim(["--next", "--as", "fe-worker", "--team-dir", teamDir])).rejects.toThrow(
      ConfigError,
    );
  });

  test("AC5: no eligible work → exit 0, empty stdout (no-op tick)", async () => {
    await seedTeam({ feLane: true });
    const id = await addTask(atmuxDir, { subject: "x", lane: "fe" });
    await moveTask(atmuxDir, id, "done");
    const { out, result } = await captureStdout(() =>
      claim(["--next", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(out).toBe("");
  });

  test("AC6: tie-break — priority asc + createdAt asc; oldest of tied priority wins", async () => {
    await seedTeam({ feLane: true });
    const first = await addTask(atmuxDir, { subject: "first", lane: "fe", priority: 2 });
    // Different createdAt — addTask stamps now-epoch in seconds; force a 1-tick gap.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await addTask(atmuxDir, { subject: "second", lane: "fe", priority: 2 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--as", "fe-worker", "--team-dir", teamDir]),
    );
    expect(out).toContain(first);
    expect(out).not.toContain(second);
  });

  test("missing member resolution → UsageError", async () => {
    await seedTeam({ feLane: true });
    await addTask(atmuxDir, { subject: "x", lane: "fe" });
    await expect(claim(["--next", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("lane-less caller falls back to lane=null tasks", async () => {
    await seedTeam({ feLane: false, laneless: true });
    const noLaneId = await addTask(atmuxDir, { subject: "misc" });
    await addTask(atmuxDir, { subject: "fe job", lane: "fe", priority: 1 });
    const { out } = await captureStdout(() =>
      claim(["--next", "--as", "drifter", "--team-dir", teamDir]),
    );
    expect(out).toContain(`drifter claimed ${noLaneId}`);
  });
});
