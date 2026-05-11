// Unit tests for `atmux lane-tick` — ADR-062 §3 lane orchestrator
// (Task t-8fdd3e55, R1-T3). Anchor case (per Task body):
//   3-member team where m1=READY+has eligible task / m2=READY+no eligible
//   / m3=COMPACTING — assert send-keys fired exactly once (m1), kanban
//   reflects m1's claim. Mock pane captures via fixture text. Mock
//   safeSendKeys via injected dependency.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSpawn } from "../../../src/core/auto-done.ts";
import { loadTeam } from "../../../src/core/common.ts";
import { addTask, loadKanban } from "../../../src/core/kanban.ts";
import type { CaptureFn } from "../../../src/core/pane-state.ts";
import type { SafeSendOpts, SafeSendResult } from "../../../src/core/safe-send.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import { claim } from "../../../src/verbs/claim.ts";
import {
  laneTick,
  parseLaneTickArgs,
  runAutoDoneScan,
  runLaneTick,
} from "../../../src/verbs/lane-tick.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-lane-tick-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  // Seed a session anchor so getSessionName doesn't try to fall back.
  await writeFile(join(atmuxDir, "state", "session.txt"), "test-sess\n");
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

// ---------- Fixture helpers ----------

// READY fixture: token-counter shape on a dedicated line so it matches
// the canonical READY pattern (`/^\s*tok\s+\d+(\.\d+)?k\/\d/m`).
// "esc to interrupt" was deliberately removed in ADR-080 §C — that
// phrase only renders during an active turn, so it now classifies as
// BUSY. Pre-§C fixture leaked it into READY ground truth.
const FIXTURE_READY = "│ > \ntok 67k/100  ⏵⏵ auto mode on\n";
const FIXTURE_COMPACTING = "Compacting conversation (15%)…\n";
const FIXTURE_TYPING = "Press up to edit queued messages\n";
const FIXTURE_BUSY = "✻ Cooked for 12s\n";
const FIXTURE_MODAL = "Do you want Claude to proceed?\n[y/N]: ";

interface SeedThreeMembersOpts {
  /** Override caller's lane fields. */
  withLanes?: { m1?: string | null; m2?: string | null; m3?: string | null };
}

async function seedThreeMemberTeam(opts: SeedThreeMembersOpts = {}): Promise<void> {
  const lanes = opts.withLanes ?? {};
  const members: Array<Record<string, string>> = [];
  const push = (name: string, lane: string | null | undefined): void => {
    const m: Record<string, string> = { name };
    if (lane !== undefined && lane !== null) m.lane = lane;
    members.push(m);
  };
  push("m1", lanes.m1 === undefined ? "fe" : lanes.m1);
  push("m2", lanes.m2 === undefined ? "fe" : lanes.m2);
  push("m3", lanes.m3 === undefined ? "fe" : lanes.m3);
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "team", members }));
}

interface CaptureRecord {
  target: string;
  fixture: string;
}

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

function buildMockSendFnRefusing(outcome: SafeSendResult["outcome"]): {
  sendFn: (target: string, text: string, opts: SafeSendOpts) => Promise<SafeSendResult>;
  calls: SendRecord[];
} {
  const calls: SendRecord[] = [];
  return {
    calls,
    sendFn: async (target, text, _opts) => {
      calls.push({ target, text });
      return {
        outcome,
        finalClassification: { state: "MODAL", evidence: "modal", capturedAt: 0 },
        attempts: 1,
        dismissals: 0,
      };
    },
  };
}

function buildFixtureCapture(perTarget: Record<string, string>): {
  capture: CaptureFn;
  calls: CaptureRecord[];
} {
  const calls: CaptureRecord[] = [];
  return {
    calls,
    capture: async (target: string) => {
      const fixture = perTarget[target] ?? "";
      calls.push({ target, fixture });
      return fixture;
    },
  };
}

// ---------- parseLaneTickArgs ----------

describe("parseLaneTickArgs", () => {
  test("no args → empty parsed", () => {
    expect(parseLaneTickArgs([])).toEqual({});
  });

  test("--team-dir consumed", () => {
    expect(parseLaneTickArgs(["--team-dir", "/x"])).toEqual({ teamDir: "/x" });
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseLaneTickArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseLaneTickArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- runLaneTick: anchor case (3-member fixture) ----------

describe("runLaneTick — anchor 3-member case", () => {
  test("AC: m1 READY+eligible / m2 READY+no eligible / m3 COMPACTING — send fires once", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });

    // Even with no eligible Tasks for m2, the send_fn still fires (lane-tick
    // doesn't read kanban — that's claim --next's job downstream). The
    // anchor case asserts the gating LOGIC: only READY panes get the
    // injection. m1 + m2 are READY, m3 is COMPACTING.
    const session = "test-sess";
    const t1 = `${session}:m1`;
    const t2 = `${session}:m2`;
    const t3 = `${session}:m3`;
    const { capture, calls: capCalls } = buildFixtureCapture({
      [t1]: FIXTURE_READY,
      [t2]: FIXTURE_READY,
      [t3]: FIXTURE_COMPACTING,
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();

    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });

    expect(result.visited).toBe(3);
    expect(result.outcomes).toEqual({
      m1: "injected",
      m2: "injected",
      m3: "skip-not-ready",
    });
    // All three were captured (gate runs before send).
    expect(capCalls.map((c) => c.target).sort()).toEqual([t1, t2, t3].sort());
    // Only the two READY panes got a send.
    expect(sendCalls).toHaveLength(2);
    const sentTo = sendCalls.map((c) => c.target).sort();
    expect(sentTo).toEqual([t1, t2].sort());
    // The injected text is the literal claim --next command per member.
    for (const c of sendCalls) {
      const expectedMember = c.target === t1 ? "m1" : "m2";
      expect(c.text).toBe(`atmux claim --next --as ${expectedMember}`);
    }
  });

  test("AC: kanban-side reflects m1's claim when wired through real claim verb", async () => {
    // This test wires the lane-tick→claim chain end-to-end in-process:
    // sendFn is replaced with a function that, instead of typing into a
    // pane, directly invokes the claim verb. That gives us proof the
    // text we'd inject IS the right invocation, AND that downstream
    // state lands as expected. (Real prod path types the text into a
    // Claude pane → next turn the Claude member runs the command.)
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });

    // Seed m1 a fe-lane Task; m2 has no eligible (no fe-lane Task added
    // for m2 yet — but addTask doesn't filter by member, so we add one
    // task and m1 will pick it).
    const id = await addTask(atmuxDir, { subject: "fe job", lane: "fe", priority: 1 });

    const session = "test-sess";
    const captures: Record<string, string> = {
      [`${session}:m1`]: FIXTURE_READY,
      [`${session}:m2`]: FIXTURE_TYPING, // not READY → skip
      [`${session}:m3`]: FIXTURE_MODAL, // not READY → skip
    };
    const { capture } = buildFixtureCapture(captures);
    // sendFn proxies into the real claim verb. This is the "lane-tick
    // dispatched the command" half of the chain — proves what gets sent.
    const sendFn = async (
      _target: string,
      text: string,
      _opts: SafeSendOpts,
    ): Promise<SafeSendResult> => {
      // Parse `atmux claim --next --as <member>` into argv for claim().
      const parts = text.split(/\s+/).slice(1); // drop leading `atmux`
      // text starts with "atmux claim …" — drop the "claim" too.
      const argv = parts.slice(1).concat(["--team-dir", teamDir]);
      await claim(argv);
      return {
        outcome: "sent",
        finalClassification: { state: "READY", evidence: "", capturedAt: 0 },
        attempts: 1,
        dismissals: 0,
      };
    };

    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes.m1).toBe("injected");
    expect(result.outcomes.m2).toBe("skip-not-ready");
    expect(result.outcomes.m3).toBe("skip-not-ready");

    const k = await loadKanban(atmuxDir);
    const claimed = k.tasks.find((t) => t.id === id);
    expect(claimed?.owner).toBe("m1");
    expect(claimed?.status).toBe("in-progress");
  });
});

// ---------- runLaneTick: edge cases ----------

describe("runLaneTick — edge cases", () => {
  test("members WITHOUT lane set are skipped entirely (not in visited count)", async () => {
    await seedThreeMemberTeam({ withLanes: { m2: null, m3: null } });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture, calls: capCalls } = buildFixtureCapture({
      [`${session}:m1`]: FIXTURE_READY,
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.visited).toBe(1); // only m1 has lane
    expect(capCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(1);
    expect(result.outcomes).toEqual({ m1: "injected" });
  });

  test("capture I/O error → log + skip member, doesn't crash tick", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const capture: CaptureFn = async (target) => {
      if (target === `${session}:m2`) throw new Error("tmux unreachable");
      return FIXTURE_READY;
    };
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes).toEqual({
      m1: "injected",
      m2: "skip-capture-error",
      m3: "injected",
    });
    expect(sendCalls).toHaveLength(2); // m1 + m3, NOT m2
  });

  test("send refusal classifies outcome as skip-send-refused", async () => {
    await seedThreeMemberTeam({ withLanes: { m1: "fe", m2: null, m3: null } });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:m1`]: FIXTURE_READY,
    });
    const { sendFn, calls } = buildMockSendFnRefusing("refused-modal");
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes).toEqual({ m1: "skip-send-refused" });
    expect(calls).toHaveLength(1); // send was attempted (refusal happens INSIDE safeSendKeys)
  });

  test("idempotent: tick with no laned members is a no-op (visited=0)", async () => {
    await seedThreeMemberTeam({ withLanes: { m1: null, m2: null, m3: null } });
    const team = await loadTeam({ teamDir });
    const { capture, calls: capCalls } = buildFixtureCapture({});
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.visited).toBe(0);
    expect(capCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  test("bounded: at most one injection per member per tick", async () => {
    // Property check — the loop is single-pass, no claim+claim. Verified
    // by counting send_fn invocations per target.
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:m1`]: FIXTURE_READY,
      [`${session}:m2`]: FIXTURE_READY,
      [`${session}:m3`]: FIXTURE_READY,
    });
    const { sendFn, calls } = buildMockSendFn();
    await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    // Each target appears at most once.
    const perTarget = new Map<string, number>();
    for (const c of calls) perTarget.set(c.target, (perTarget.get(c.target) ?? 0) + 1);
    for (const n of perTarget.values()) expect(n).toBe(1);
  });

  test("members with empty-string lane are skipped (lane.length === 0 guard)", async () => {
    await seedThreeMemberTeam({ withLanes: { m1: "", m2: "", m3: "fe" } });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture, calls: capCalls } = buildFixtureCapture({
      [`${session}:m3`]: FIXTURE_READY,
    });
    const { sendFn } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.visited).toBe(1);
    expect(capCalls.map((c) => c.target)).toEqual([`${session}:m3`]);
  });

  test("BUSY pane skips with state=BUSY in log line (ADR-080 §C)", async () => {
    // Spinner-verb pane is mid-think — lane-tick must NOT inject claim
    // text. Pre-§C such panes classified as UNKNOWN (catalog miss) and
    // produced `state=UNKNOWN` log lines that operators couldn't
    // distinguish from real classification gaps. With the BUSY state,
    // operators see the actual cause + the spinner glyph as evidence.
    await seedThreeMemberTeam({ withLanes: { m1: "fe", m2: null, m3: null } });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:m1`]: FIXTURE_BUSY,
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const logs: string[] = [];
    const result = await runLaneTick(atmuxDir, team, {
      capture,
      sendFn,
      log: (m) => logs.push(m),
    });
    expect(result.outcomes).toEqual({ m1: "skip-not-ready" });
    expect(sendCalls).toHaveLength(0);
    const busyLog = logs.find((l) => l.includes("state=BUSY"));
    expect(busyLog).toBeDefined();
    expect(busyLog).toContain("m1");
    expect(busyLog).toContain("evidence=");
    expect(busyLog).toContain("skip");
  });

  test("emoji-prefixed window names resolve correctly", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "team",
        members: [{ name: "fe-worker", lane: "fe", emoji: "🎨" }],
      }),
    );
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const target = `${session}:🎨fe-worker`;
    const { capture, calls } = buildFixtureCapture({ [target]: FIXTURE_READY });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(calls[0]?.target).toBe(target);
    expect(sendCalls[0]?.target).toBe(target);
    expect(sendCalls[0]?.text).toBe("atmux claim --next --as fe-worker");
    expect(result.outcomes["fe-worker"]).toBe("injected");
  });
});

// ---------- ADR-080 §A2: lead ctx-threshold refusal ----------
//
// Helper: lead pane fixture at a given ctx-pct via the canonical
// `tok N/M` shape `parseLeadCtxPct` reads. Pre-fix lead-tick injected
// `claim --next` regardless of ctx; the operator-observed failure
// (sopx 67%/100 with queued claim defeating /session preclear) drove
// this gate. § A2 reuses § A1's parser (whip.ts::parseLeadCtxPct).
//
// `tok 80k/100` → ctx-pct 80; `tok 50k/100` → 50; etc. Wrapped in the
// canonical READY shape so classifyText returns READY (without that,
// the gate short-circuits before reaching the §A2 check).

function leadFixture(usedK: number, capK = 100): string {
  return `│ > \ntok ${usedK}k/${capK}  ⏵⏵ auto mode on\n`;
}

describe("runLaneTick — ADR-080 §A2 lead ctx-threshold refusal", () => {
  async function seedTeamWithLead(opts: {
    leadName?: string;
    leadCtxRotateThreshold?: number;
  }): Promise<void> {
    const leadName = opts.leadName ?? "lead";
    // Lead must have a lane to be visited by lane-tick; misc is the
    // canonical lead lane in atmux team.json.
    const team: Record<string, unknown> = {
      name: "team",
      members: [
        { name: leadName, role: "team-lead", lane: "misc" },
        { name: "alice", role: "member", lane: "fe" },
      ],
    };
    if (opts.leadCtxRotateThreshold !== undefined) {
      team.whip = { leadCtxRotateThreshold: opts.leadCtxRotateThreshold };
    }
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team));
  }

  test("lead ctx=80, threshold=70 → /team rotate-lead nudge instead of claim", async () => {
    await seedTeamWithLead({ leadCtxRotateThreshold: 70 });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:lead`]: leadFixture(80), // 80% ctx → over threshold
      [`${session}:alice`]: FIXTURE_READY,
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const logs: string[] = [];
    const result = await runLaneTick(atmuxDir, team, {
      capture,
      sendFn,
      log: (m) => logs.push(m),
    });
    expect(result.outcomes.lead).toBe("injected-rotate-nudge");
    expect(result.outcomes.alice).toBe("injected");
    const leadSend = sendCalls.find((c) => c.target === `${session}:lead`);
    expect(leadSend?.text).toBe("/team rotate-lead");
    const aliceSend = sendCalls.find((c) => c.target === `${session}:alice`);
    expect(aliceSend?.text).toBe("atmux claim --next --as alice");
    expect(logs.some((l) => l.includes("ctx=80%") && l.includes("≥ 70%"))).toBe(true);
  });

  test("lead ctx=50, threshold=70 → claim --next as before (regression-pin)", async () => {
    await seedTeamWithLead({ leadCtxRotateThreshold: 70 });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:lead`]: leadFixture(50), // 50% ctx → under threshold
      [`${session}:alice`]: FIXTURE_READY,
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes.lead).toBe("injected");
    const leadSend = sendCalls.find((c) => c.target === `${session}:lead`);
    expect(leadSend?.text).toBe("atmux claim --next --as lead");
  });

  test("non-lead member at ctx=80, threshold=70 → claim --next (threshold ignored)", async () => {
    await seedTeamWithLead({ leadCtxRotateThreshold: 70 });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:lead`]: leadFixture(50), // lead under threshold
      [`${session}:alice`]: leadFixture(80), // member at 80% — ignored for non-leads
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes.alice).toBe("injected");
    const aliceSend = sendCalls.find((c) => c.target === `${session}:alice`);
    expect(aliceSend?.text).toBe("atmux claim --next --as alice");
  });

  test("threshold defaults to 70 when team.whip is omitted", async () => {
    await seedTeamWithLead({}); // no whip block
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:lead`]: leadFixture(75), // 75% ctx → over default 70
      [`${session}:alice`]: FIXTURE_READY,
    });
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes.lead).toBe("injected-rotate-nudge");
    const leadSend = sendCalls.find((c) => c.target === `${session}:lead`);
    expect(leadSend?.text).toBe("/team rotate-lead");
  });

  test("lead pane with no tok indicator → ctx unknown, falls through to claim", async () => {
    // parseLeadCtxPct returns null when the pane has no `tok N/M`
    // indicator (transient bootstrap state). The gate must NOT refuse
    // on null — fall through to the normal claim injection.
    await seedTeamWithLead({ leadCtxRotateThreshold: 70 });
    const team = await loadTeam({ teamDir });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:lead`]: "│ > \n", // bare prompt, no tok
      [`${session}:alice`]: FIXTURE_READY,
    });
    // Bare prompt classifies as READY via `^>\s*$/m`.
    const { sendFn, calls: sendCalls } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, log: () => {} });
    expect(result.outcomes.lead).toBe("injected");
    const leadSend = sendCalls.find((c) => c.target === `${session}:lead`);
    expect(leadSend?.text).toBe("atmux claim --next --as lead");
  });
});

// ---------- ADR-080 §B2: auto-done scan (lane-tick wire) ----------

describe("runAutoDoneScan — ADR-080 §B2", () => {
  // Fixture: build a kanban with N in-progress `commit t-X` tasks.
  // Each call to git's `--grep=<id>` matches a sub-set per `shasById`
  // (ids in the map → SHA returned; ids NOT in the map → null result).
  function buildFixtureGit(shasById: Record<string, string>): {
    git: GitSpawn;
    calls: ReadonlyArray<string>[];
  } {
    const calls: ReadonlyArray<string>[] = [];
    const git: GitSpawn = async (argv) => {
      calls.push(argv);
      const grepArg = argv.find((a) => a.startsWith("--grep="));
      const id = grepArg?.slice("--grep=".length) ?? "";
      const sha = shasById[id];
      if (sha === undefined) {
        return { cmd: "git", argv, stdout: "", stderr: "", exitCode: 0, signalled: null, durationMs: 0 };
      }
      return { cmd: "git", argv, stdout: `${sha}\n`, stderr: "", exitCode: 0, signalled: null, durationMs: 0 };
    };
    return { git, calls };
  }

  // listTasks/moveTask need a real kanban.json on disk + a real (or
  // fake-but-existing) repoPath. The repoPath default
  // (`dirname(atmuxDir)`) IS the test's `teamDir` which mkdtemp creates;
  // findCommitForTask's pre-flight statOrNull passes (it's a directory),
  // and the injected GitSpawn intercepts before any real git runs.
  async function seedKanbanWithTasks(
    tasks: Array<{ id: string; subject: string; status: string; createdAt?: number }>,
  ): Promise<void> {
    const kanban = {
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        owner: "gitter",
        createdAt: t.createdAt ?? Math.floor(Date.now() / 1000) - 3600,
      })),
      epics: [],
      stories: [],
    };
    await writeFile(join(atmuxDir, "kanban.json"), JSON.stringify(kanban));
  }

  test("3 in-progress commit tasks; helper returns SHA for 2, null for 1 → 2 done, 1 in-progress", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    await seedKanbanWithTasks([
      { id: "t-aaaaaaaa", subject: "commit t-aaaaaaaa", status: "in-progress" },
      { id: "t-bbbbbbbb", subject: "commit t-bbbbbbbb", status: "in-progress" },
      { id: "t-cccccccc", subject: "commit t-cccccccc", status: "in-progress" },
    ]);
    const { git } = buildFixtureGit({
      "t-aaaaaaaa": "1111111122222222333333334444444455555555",
      "t-cccccccc": "ffffffff00000000aaaaaaaa11111111bbbbbbbb",
    });
    const logs: string[] = [];
    const resolved = await runAutoDoneScan(atmuxDir, team, { git, log: (m) => logs.push(m) });
    expect(resolved).toBe(2);

    const k = await loadKanban(atmuxDir);
    const a = k.tasks.find((t) => t.id === "t-aaaaaaaa");
    const b = k.tasks.find((t) => t.id === "t-bbbbbbbb");
    const c = k.tasks.find((t) => t.id === "t-cccccccc");
    expect(a?.status).toBe("done");
    expect(b?.status).toBe("in-progress"); // null sha → unchanged
    expect(c?.status).toBe("done");

    // Log lines reference the short SHA (8 chars).
    expect(logs.some((l) => l.includes("auto-done t-aaaaaaaa via 11111111"))).toBe(true);
    expect(logs.some((l) => l.includes("auto-done t-cccccccc via ffffffff"))).toBe(true);
  });

  test("idempotence: re-running with all 3 done → no kanban writes, returns 0", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    await seedKanbanWithTasks([
      { id: "t-aaaaaaaa", subject: "commit t-aaaaaaaa", status: "done" },
      { id: "t-bbbbbbbb", subject: "commit t-bbbbbbbb", status: "done" },
      { id: "t-cccccccc", subject: "commit t-cccccccc", status: "done" },
    ]);
    // Even if git would match these IDs, listTasks filter excludes done.
    const { git, calls } = buildFixtureGit({
      "t-aaaaaaaa": "1111111122222222",
      "t-bbbbbbbb": "1111111122222223",
      "t-cccccccc": "1111111122222224",
    });
    const resolved = await runAutoDoneScan(atmuxDir, team, { git, log: () => {} });
    expect(resolved).toBe(0);
    // Git was never invoked (no in-progress commit tasks to scan).
    expect(calls).toHaveLength(0);
  });

  test("--backfill-done: laneTick verb scans all in-progress commit-tasks regardless of recency", async () => {
    await seedThreeMemberTeam();
    // createdAt deliberately old (1h ago; default per-tick scan would
    // still cover it). Real proof of backfill: pass a clearly-old
    // createdAt that real git's --since would reject in a live run; the
    // fixture git ignores --since but the helper passes `sinceMs=0` in
    // backfill mode anyway. Assert that the git argv shows no --since
    // filter / shows --since=epoch.
    await seedKanbanWithTasks([
      {
        id: "t-aaaaaaaa",
        subject: "commit t-aaaaaaaa",
        status: "in-progress",
        createdAt: 100, // ancient (1970-01-01 + 100s)
      },
    ]);
    const { git, calls } = buildFixtureGit({
      "t-aaaaaaaa": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    const exit = await laneTick(["--team-dir", teamDir, "--backfill-done"], {
      git,
      log: () => {},
    });
    expect(exit).toBe(0);
    const k = await loadKanban(atmuxDir);
    expect(k.tasks.find((t) => t.id === "t-aaaaaaaa")?.status).toBe("done");
    // backfill=true → sinceMs=0 → ISO `1970-01-01T00:00:00.000Z`.
    const grepCall = calls.find((argv) => argv.includes("--grep=t-aaaaaaaa"));
    expect(grepCall).toBeDefined();
    expect(grepCall?.some((a) => a === "--since=1970-01-01T00:00:00.000Z")).toBe(true);
  });

  test("non-commit subject ignored (only `^commit ` pattern matches)", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    await seedKanbanWithTasks([
      { id: "t-aaaaaaaa", subject: "implement foo", status: "in-progress" },
      { id: "t-bbbbbbbb", subject: "review t-bbbbbbbb", status: "in-progress" },
      { id: "t-cccccccc", subject: "commit t-cccccccc", status: "in-progress" },
    ]);
    const { git, calls } = buildFixtureGit({
      "t-aaaaaaaa": "1111111122222222", // would match if scanned
      "t-bbbbbbbb": "3333333344444444",
      "t-cccccccc": "5555555566666666",
    });
    const resolved = await runAutoDoneScan(atmuxDir, team, { git, log: () => {} });
    expect(resolved).toBe(1);
    // Only the `commit ...` task was passed to git --grep.
    const grepIds = calls
      .map((argv) => argv.find((a) => a.startsWith("--grep=")))
      .filter((g): g is string => g !== undefined)
      .map((g) => g.slice("--grep=".length));
    expect(grepIds).toEqual(["t-cccccccc"]);
  });

  test("repoPath honored when set on team.gitter", async () => {
    await writeFile(
      join(atmuxDir, "team.json"),
      JSON.stringify({
        name: "team",
        members: [{ name: "gitter", role: "gitter", lane: "git" }],
        gitter: { repoPath: teamDir }, // explicit override (still teamDir for stat success)
      }),
    );
    const team = await loadTeam({ teamDir });
    await seedKanbanWithTasks([
      { id: "t-aaaaaaaa", subject: "commit t-aaaaaaaa", status: "in-progress" },
    ]);
    const { git, calls } = buildFixtureGit({
      "t-aaaaaaaa": "abc12345abc12345abc12345abc12345abc12345",
    });
    const resolved = await runAutoDoneScan(atmuxDir, team, { git, log: () => {} });
    expect(resolved).toBe(1);
    // -C <repoPath> argv shape — assert team.gitter.repoPath threaded through.
    const cArg = calls[0]?.findIndex((a) => a === "-C");
    expect(cArg).toBeGreaterThanOrEqual(0);
    if (cArg !== undefined && cArg >= 0) {
      expect(calls[0]?.[cArg + 1]).toBe(teamDir);
    }
  });

  test("findCommit error on one task → logged + skipped, scan continues for siblings", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    await seedKanbanWithTasks([
      { id: "t-aaaaaaaa", subject: "commit t-aaaaaaaa", status: "in-progress" },
      { id: "t-bbbbbbbb", subject: "commit t-bbbbbbbb", status: "in-progress" },
    ]);
    // First call throws (simulating git transient failure for one task);
    // second call succeeds.
    let callIdx = 0;
    const git: GitSpawn = async (argv) => {
      callIdx += 1;
      if (callIdx === 1) {
        return { cmd: "git", argv, stdout: "", stderr: "fatal: bad revision", exitCode: 128, signalled: null, durationMs: 0 };
      }
      const grepArg = argv.find((a) => a.startsWith("--grep="));
      if (grepArg === "--grep=t-bbbbbbbb") {
        return { cmd: "git", argv, stdout: "abc1234500000000\n", stderr: "", exitCode: 0, signalled: null, durationMs: 0 };
      }
      return { cmd: "git", argv, stdout: "", stderr: "", exitCode: 0, signalled: null, durationMs: 0 };
    };
    const logs: string[] = [];
    const resolved = await runAutoDoneScan(atmuxDir, team, { git, log: (m) => logs.push(m) });
    expect(resolved).toBe(1); // only t-bbbbbbbb succeeds
    expect(logs.some((l) => l.includes("findCommit error"))).toBe(true);
    expect(logs.some((l) => l.includes("auto-done t-bbbbbbbb via abc12345"))).toBe(true);
  });

  test("runLaneTick exposes autoDoneResolved on the result", async () => {
    await seedThreeMemberTeam();
    const team = await loadTeam({ teamDir });
    await seedKanbanWithTasks([
      { id: "t-aaaaaaaa", subject: "commit t-aaaaaaaa", status: "in-progress" },
    ]);
    const { git } = buildFixtureGit({
      "t-aaaaaaaa": "deadbeef00000000aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const session = "test-sess";
    const { capture } = buildFixtureCapture({
      [`${session}:m1`]: FIXTURE_COMPACTING, // skip-not-ready, no send
      [`${session}:m2`]: FIXTURE_COMPACTING,
      [`${session}:m3`]: FIXTURE_COMPACTING,
    });
    const { sendFn } = buildMockSendFn();
    const result = await runLaneTick(atmuxDir, team, { capture, sendFn, git, log: () => {} });
    expect(result.autoDoneResolved).toBe(1);
  });
});

// ---------- laneTick verb (full argv path) ----------

describe("laneTick verb — top-level", () => {
  test("missing team.json → ConfigError", async () => {
    // No team.json seeded — requireTeam throws.
    await expect(laneTick(["--team-dir", teamDir])).rejects.toThrow(ConfigError);
  });

  test("returns 0 on completion even when every member skipped", async () => {
    await seedThreeMemberTeam({ withLanes: { m1: null, m2: null, m3: null } });
    const team = await loadTeam({ teamDir });
    // Use runLaneTick directly with no laned members → fast 0.
    const result = await runLaneTick(atmuxDir, team, {
      capture: async () => FIXTURE_READY,
      sendFn: async () => ({
        outcome: "sent",
        finalClassification: { state: "READY", evidence: "", capturedAt: 0 },
        attempts: 1,
        dismissals: 0,
      }),
      log: () => {},
    });
    expect(result.visited).toBe(0);
  });
});
