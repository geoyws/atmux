// Unit tests for `atmux lane-tick` — ADR-157 T4 goal-narrow branch
// (Task t-e8ad0db5). Exercises the 5-cell matrix from the task body
// verbatim + the three preserved safety-net assertions.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTeam } from "../../../src/core/common.ts";
import type { CaptureFn } from "../../../src/core/pane-state.ts";
import type { SafeSendOpts, SafeSendResult } from "../../../src/core/safe-send.ts";
import type { TeamMember } from "../../../src/schema/team.ts";
import { runLaneTick } from "../../../src/verbs/lane-tick.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-lane-tick-goal-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Fixtures shared with lane-tick.test.ts ----------

const FIXTURE_READY = "│ > \ntok 67k/100  ⏵⏵ auto mode on\n";
const FIXTURE_COMPACTING = "Compacting conversation (15%)…\n";
const FIXTURE_LEAD_HIGH_CTX =
  "│ > \ntok 80k/100  ⏵⏵ auto mode on  ctx 75%\n";

interface SendRecord {
  target: string;
  text: string;
}

function buildMockSendFn(): {
  sendFn: (target: string, text: string, opts: SafeSendOpts) => Promise<SafeSendResult>;
  calls: SendRecord[];
} {
  const calls: SendRecord[] = [];
  return {
    calls,
    sendFn: async (target, text, _opts) => {
      calls.push({ target, text });
      return {
        outcome: "sent",
        finalClassification: { state: "READY", evidence: "", capturedAt: 0 },
        attempts: 1,
        dismissals: 0,
      };
    },
  };
}

function buildFixtureCapture(perTarget: Record<string, string>): CaptureFn {
  return async (target: string) => perTarget[target] ?? "";
}

async function seedTeamWithMembers(members: TeamMember[]): Promise<void> {
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "team", members }, null, 2),
  );
}

// ---------- ADR-157 T4 — 5-cell goal-narrow matrix ----------

describe("runLaneTick — ADR-157 T4 goal-narrow (5-cell matrix)", () => {
  test("(1) goal-active claude alive → claim-injection SKIPPED + skip-goal-active outcome", async () => {
    await seedTeamWithMembers([
      {
        name: "alice",
        lane: "be",
        runtime: "claude",
        goal: "Kanban.status=blocked column is empty",
      },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:alice";
    const logs: string[] = [];
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_READY }),
      sendFn,
      log: (m) => logs.push(m),
      resolveGoal: async () => "Kanban.status=blocked column is empty",
    });

    expect(calls).toEqual([]); // no claim --next fired
    expect(result.outcomes["alice"]).toBe("skip-goal-active");
    expect(
      logs.some((l) =>
        l.includes("[lane-tick] skip claim-inject for alice: goal-active (resolved-via=team.json)"),
      ),
    ).toBe(true);
  });

  test("(2) goal-active CURSOR alive → claim-injection RAN (cursor runtime-gate)", async () => {
    await seedTeamWithMembers([
      {
        name: "martinet",
        lane: "be",
        runtime: "cursor",
        goal: "would-be-ignored-on-cursor",
      },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:martinet";
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_READY }),
      sendFn,
      log: () => {},
      // Even if resolveGoal returns non-null, the cursor runtime-gate
      // short-circuits BEFORE goal resolution — claim-injection fires.
      resolveGoal: async () => "should-be-skipped-for-cursor",
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toBe("atmux claim --next --as martinet");
    expect(result.outcomes["martinet"]).toBe("injected");
  });

  test("(3) goal-active claude DEAD-PANE → claim-injection SKIPPED + dead-pane (skip-not-ready) logged, NOT skip-goal-active", async () => {
    await seedTeamWithMembers([
      {
        name: "alice",
        lane: "be",
        runtime: "claude",
        goal: "x",
      },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:alice";
    const logs: string[] = [];
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_COMPACTING }),
      sendFn,
      log: (m) => logs.push(m),
      resolveGoal: async () => "x",
    });

    expect(calls).toEqual([]);
    // Per reviewer pre-flag #1: skip-not-ready fires BEFORE goal-skip
    // so wedged goal-active members surface as pane-health issues,
    // NOT as goal-skipped (which would mask the dead pane).
    expect(result.outcomes["alice"]).toBe("skip-not-ready");
    expect(
      logs.some((l) => l.includes("alice:") && l.includes("skip")),
    ).toBe(true);
  });

  test("(4) goal-inactive claude → claim-injection RAN (existing behavior preserved)", async () => {
    await seedTeamWithMembers([
      { name: "alice", lane: "be", runtime: "claude" },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:alice";
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_READY }),
      sendFn,
      log: () => {},
      resolveGoal: async () => null,
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toBe("atmux claim --next --as alice");
    expect(result.outcomes["alice"]).toBe("injected");
  });

  test("(5) goal-inactive claude + dead-pane → skip-not-ready (existing rate-limit / dead-pane branch preserved)", async () => {
    await seedTeamWithMembers([
      { name: "alice", lane: "be", runtime: "claude" },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:alice";
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_COMPACTING }),
      sendFn,
      log: () => {},
      resolveGoal: async () => null,
    });

    expect(calls).toEqual([]);
    expect(result.outcomes["alice"]).toBe("skip-not-ready");
  });
});

// ---------- ADR-157 T4 — three preserved safety nets ----------

describe("runLaneTick — ADR-157 §D5 safety-net preservation", () => {
  test("safety net #2 (lead-ctx-rotate nudge) FIRES for goal-active lead — preserved over goal-skip", async () => {
    await seedTeamWithMembers([
      {
        name: "lead",
        role: "team-lead",
        lane: "be",
        runtime: "claude",
        goal: "All members commit in last 30min",
      },
    ]);
    // Write team.json again with whip block so leadCtxRotateThreshold
    // is in scope (default 70 anyway, but explicit for clarity).
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "team",
        members: [
          {
            name: "lead",
            role: "team-lead",
            lane: "be",
            runtime: "claude",
            goal: "All members commit in last 30min",
          },
        ],
        whip: { leadCtxRotateThreshold: 70 },
      }),
    );
    const team = await loadTeam({ teamDir });
    const t = "test-sess:lead";
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_LEAD_HIGH_CTX }),
      sendFn,
      log: () => {},
      resolveGoal: async () => "All members commit in last 30min",
    });

    // ADR-157 §D5 #2: lead-ctx-rotate nudge MUST fire for goal-active
    // leads — /goal can't self-rotate. Outcome must be the rotate
    // nudge, NOT skip-goal-active.
    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toBe("/team rotate-lead");
    expect(result.outcomes["lead"]).toBe("injected-rotate-nudge");
  });

  test("safety net #1 (auto-done sweep) runs INDEPENDENT of goal-state — verified via autoDoneResolved field reachable", async () => {
    await seedTeamWithMembers([
      { name: "alice", lane: "be", runtime: "claude", goal: "x" },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:alice";

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_READY }),
      sendFn: buildMockSendFn().sendFn,
      log: () => {},
      resolveGoal: async () => "x",
    });

    // The auto-done scan runs unconditionally AFTER the per-member
    // loop. With no in-progress commit-tasks in our temp kanban,
    // resolved=0 — but the field is populated (not undefined),
    // proving the scan executed even with the only member skipped
    // by goal-active. Reviewer pre-flag #3.
    expect(result.outcomes["alice"]).toBe("skip-goal-active");
    expect(result.autoDoneResolved).toBe(0);
  });

  test("safety net #3 (dead-pane detection) wins over goal-skip — see matrix test (3) above", () => {
    // Documented here for traceability; the assertion already lives
    // in the matrix test "(3) goal-active claude DEAD-PANE → ..."
    // which proves wedged goal-active members surface as
    // skip-not-ready (the pane-health signal) rather than getting
    // masked by skip-goal-active.
    expect(true).toBe(true);
  });
});

// ---------- ADR-157 T4 — goal-resolver failure fallback ----------

describe("runLaneTick — goal-resolver failure mode", () => {
  test("resolveGoal throws → falls through to claim --next (conservative)", async () => {
    await seedTeamWithMembers([
      { name: "alice", lane: "be", runtime: "claude" },
    ]);
    const team = await loadTeam({ teamDir });
    const t = "test-sess:alice";
    const logs: string[] = [];
    const { sendFn, calls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, {
      capture: buildFixtureCapture({ [t]: FIXTURE_READY }),
      sendFn,
      log: (m) => logs.push(m),
      resolveGoal: async () => {
        throw new Error("brief-parser blew up");
      },
    });

    // Conservative: a goal-resolver failure MUST NOT silently skip
    // claim-injection. Drain stays healthy; operator sees the warn.
    expect(calls.length).toBe(1);
    expect(calls[0]?.text).toBe("atmux claim --next --as alice");
    expect(result.outcomes["alice"]).toBe("injected");
    expect(
      logs.some((l) => l.includes("goal-resolve error") && l.includes("alice")),
    ).toBe(true);
  });
});
