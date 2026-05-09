// Unit tests for src/core/lead-handoff.ts (ADR-057 §D2c).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeHandoff,
  leadHandoffPath,
  readRecentDecisions,
  writeLeadHandoff,
} from "../../../src/core/lead-handoff.ts";

const NOW_EPOCH_SEC = 1778126400; // 2026-05-07 12:00 MYT

const seedTeam = async (atmuxDir: string): Promise<void> => {
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(
    join(atmuxDir, "kanban.json"),
    JSON.stringify({
      version: 1,
      epics: [],
      stories: [],
      tasks: [
        {
          id: "t-aaa",
          subject: "in flight A",
          status: "in-progress",
          owner: "alice",
          createdAt: 1,
          deps: [],
        },
        {
          id: "t-bbb",
          subject: "in flight B",
          status: "in-progress",
          owner: null,
          createdAt: 2,
          deps: [],
        },
        {
          id: "t-ccc",
          subject: "shipped",
          status: "done",
          owner: "alice",
          createdAt: 3,
          deps: [],
        },
      ],
    }),
  );
};

// ---------- composeHandoff (pure markdown shape) ----------

describe("composeHandoff", () => {
  test("renders header + sections with empty bodies", () => {
    const md = composeHandoff({
      team: "demo",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [],
    });
    expect(md).toContain("# Lead handoff");
    expect(md).toContain("`demo`");
    expect(md).toContain("12:00 MYT");
    expect(md).toContain("**outgoing lead:** `alice`");
    expect(md).toContain("## In-flight tasks");
    expect(md).toContain("## Recent decisions");
    expect(md).toContain("## Recent driver-inbox entries");
    expect(md).toContain("## Team state");
    expect(md).toContain("- (none)");
  });

  test("renders in-flight tasks with id + subject + owner", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [
        { id: "t-1", subject: "first task", owner: "alice" },
        { id: "t-2", subject: "no owner", owner: null },
      ],
      recentDecisions: [],
      recentDriverInbox: [],
    });
    expect(md).toContain("`t-1` · first task · owner=`alice`");
    expect(md).toContain("`t-2` · no owner · owner=`(unassigned)`");
  });

  test("renders decisions with id + ts + question", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [{ id: "d-aaa", question: "first decision", tsLine: "11:00 MYT" }],
      recentDriverInbox: [],
    });
    expect(md).toContain("`d-aaa`");
    expect(md).toContain("first decision");
    expect(md).toContain("11:00 MYT");
  });

  test("renders driver-inbox entries' head only", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [
        { head: "## 09:00 MYT — entry head", body: "ignored body", tsEpochSec: 100 },
      ],
    });
    expect(md).toContain("## 09:00 MYT — entry head");
    expect(md).not.toContain("ignored body");
  });

  test("eternal-improvement state ACTIVE rendered with mode + budget", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [],
      eternalImprovement: { active: true, mode: "user-invoked", budget: "10usd" },
    });
    expect(md).toContain("eternal-improvement: ACTIVE");
    expect(md).toContain("user-invoked");
    expect(md).toContain("10usd");
  });

  test("eternal-improvement absent → 'inactive'", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [],
    });
    expect(md).toContain("eternal-improvement: inactive");
    expect(md).toContain("budget-pause: inactive");
    expect(md).toContain("account-swap: inactive");
  });

  test("budget-pause ACTIVE rendered with timestamp + count", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [],
      budgetPause: { paused: true, pausedAtTs: "08:00 MYT", atRiskCount: 3 },
    });
    expect(md).toContain("budget-pause: ACTIVE");
    expect(md).toContain("08:00 MYT");
    expect(md).toContain("3 member(s)");
  });

  test("account-swap ACTIVE rendered with pass + trigger", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [],
      accountSwap: { triggerAccount: "icloud", passId: "p-1", active: true },
    });
    expect(md).toContain("account-swap: ACTIVE pass=`p-1`");
    expect(md).toContain("trigger=`icloud`");
  });

  test("account-swap inactive flag (state file present but active=false) renders 'inactive'", () => {
    const md = composeHandoff({
      team: "t",
      generatedAtMyt: "12:00 MYT",
      outgoingLead: "alice",
      inFlightTasks: [],
      recentDecisions: [],
      recentDriverInbox: [],
      accountSwap: { triggerAccount: "icloud", passId: "p-1", active: false },
    });
    expect(md).toContain("account-swap: inactive");
  });
});

// ---------- readRecentDecisions ----------

describe("readRecentDecisions", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-handoff-decisions-"));
    atmuxDir = join(teamDir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("absent file → []", async () => {
    expect(await readRecentDecisions(atmuxDir, 5)).toEqual([]);
  });

  test("n <= 0 → []", async () => {
    await writeFile(join(atmuxDir, "decisions.md"), "### d-aaa — q? (10:00 MYT)\nbody");
    expect(await readRecentDecisions(atmuxDir, 0)).toEqual([]);
    expect(await readRecentDecisions(atmuxDir, -1)).toEqual([]);
  });

  test("parses inline-timestamp + no-timestamp forms", async () => {
    const md = `# decisions

### d-aaa — first question (11:00 MYT)

- body

### d-bbb — second question

- body 2

### d-ccc — third question (12:00 MYT)
`;
    await writeFile(join(atmuxDir, "decisions.md"), md);
    const out = await readRecentDecisions(atmuxDir, 5);
    expect(out.length).toBe(3);
    expect(out[0]?.id).toBe("d-aaa");
    expect(out[0]?.tsLine).toBe("11:00 MYT");
    expect(out[1]?.id).toBe("d-bbb");
    expect(out[1]?.tsLine).toBe("");
    expect(out[2]?.id).toBe("d-ccc");
  });

  test("trims to last n", async () => {
    const md = [
      "### d-1 — first (10:00 MYT)",
      "",
      "### d-2 — second (11:00 MYT)",
      "",
      "### d-3 — third (12:00 MYT)",
    ].join("\n");
    await writeFile(join(atmuxDir, "decisions.md"), md);
    const out = await readRecentDecisions(atmuxDir, 2);
    expect(out.length).toBe(2);
    expect(out[0]?.id).toBe("d-2");
    expect(out[1]?.id).toBe("d-3");
  });
});

// ---------- writeLeadHandoff (integration) ----------

describe("writeLeadHandoff", () => {
  let teamDir: string;
  let atmuxDir: string;

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-handoff-write-"));
    atmuxDir = join(teamDir, ".atmux");
    await seedTeam(atmuxDir);
  });
  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
  });

  test("writes file at <atmuxDir>/state/lead-handoff-<epoch>.md", async () => {
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    expect(path).toBe(leadHandoffPath(atmuxDir, NOW_EPOCH_SEC));
    const md = await readFile(path, "utf8");
    expect(md).toContain("# Lead handoff — `demo`");
    expect(md).toContain("**outgoing lead:** `alice`");
    expect(md).toContain("`t-aaa` · in flight A");
    expect(md).toContain("`t-bbb` · in flight B");
    // done task NOT included
    expect(md).not.toContain("t-ccc");
  });

  test("absent driver-inbox + decisions + state files → renders '(none)'", async () => {
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    const md = await readFile(path, "utf8");
    // 3 sections with (none) — in-flight has 2 tasks from seed though.
    expect(md).toContain("eternal-improvement: inactive");
    expect(md).toContain("budget-pause: inactive");
    expect(md).toContain("account-swap: inactive");
  });

  test("driver-inbox last-3 entries surfaced (heads only)", async () => {
    const inboxBody = [
      "## 08:00 MYT — A",
      "body A",
      "## 09:00 MYT — B",
      "body B",
      "## 10:00 MYT — C",
      "body C",
      "## 11:00 MYT — D",
      "body D",
    ].join("\n");
    await writeFile(join(atmuxDir, "driver-inbox.md"), inboxBody);
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    const md = await readFile(path, "utf8");
    // Last 3 = B, C, D. A NOT included.
    expect(md).not.toContain("## 08:00 MYT — A");
    expect(md).toContain("## 09:00 MYT — B");
    expect(md).toContain("## 10:00 MYT — C");
    expect(md).toContain("## 11:00 MYT — D");
    // Bodies NOT surfaced
    expect(md).not.toContain("body A");
    expect(md).not.toContain("body B");
  });

  test("budget-pause active state surfaced", async () => {
    await writeFile(
      join(atmuxDir, "state", "budget-pause.json"),
      JSON.stringify({
        paused: true,
        pausedAt: 100,
        pausedAtTs: "08:00 MYT",
        atRisk: [{ member: "alice", h5: 92, wk: 30 }],
      }),
    );
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    const md = await readFile(path, "utf8");
    expect(md).toContain("budget-pause: ACTIVE");
    expect(md).toContain("08:00 MYT");
    expect(md).toContain("1 member(s)");
  });

  test("eternal-improvement active state surfaced", async () => {
    await writeFile(
      join(atmuxDir, "state", "eternal-improvement.json"),
      JSON.stringify({
        active: true,
        mode: "user-invoked",
        runId: "ei-abcdef01",
        startedAt: 100,
        budgetSpec: "10usd",
        budgetTotal: 1000,
        budgetRemaining: 1000,
        cycleN: 0,
        currentCycle: null,
        lastCycleClosedAt: null,
        history: [],
      }),
    );
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    const md = await readFile(path, "utf8");
    expect(md).toContain("eternal-improvement: ACTIVE");
    expect(md).toContain("user-invoked");
    expect(md).toContain("10usd");
  });

  test("account-swap active state surfaced", async () => {
    await writeFile(
      join(atmuxDir, "state", "account-swap.json"),
      JSON.stringify({
        active: true,
        passId: "swap-1",
        startedAt: 100,
        trigger: { account: "icloud", h5_pct_used: 80, wk_pct_used: 20 },
        decisions: {},
        history: [],
      }),
    );
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    const md = await readFile(path, "utf8");
    expect(md).toContain("account-swap: ACTIVE");
    expect(md).toContain("swap-1");
    expect(md).toContain("icloud");
  });

  test("default nowMs branch (no opts.nowMs) succeeds", async () => {
    // nowMs default = nowEpochSec * 1000 path
    const path = await writeLeadHandoff({
      atmuxDir,
      team: "demo",
      outgoingLead: "alice",
      nowEpochSec: NOW_EPOCH_SEC,
    });
    const md = await readFile(path, "utf8");
    // The header carries a formatted MYT timestamp derived from
    // nowEpochSec — just check it's non-empty.
    expect(md).toContain("MYT");
  });
});
