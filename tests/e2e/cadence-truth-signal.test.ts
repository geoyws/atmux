// ADR-148 T6 (t-c0e98808): commit-cadence truth-signal e2e.
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume seed
// state (kanban Tasks filed during the walk, lane-stall dedup writes,
// classifier verdicts produced against synthetic gitLog fixtures).
// Don't streak; don't run-of-N. Per CLAUDE.md "Stateful e2e specs are
// not repeatable smokes." The walk asserts the FULL CHAIN composes:
//
//   git-log probe → cadence-classifier → atmux status column
//                                      → lane-stall-tick verb
//                                          → safeSendKeys('atmux claim t-xxx')
//                                          → dedup-state write
//                                      → wake-nudge brief shape
//                                      → backward-compat: enabled=false
//                                      → backward-compat: exemptMembers**
//
// TODO(e-a946af69): wire orchd-escalation entrypoint once orchd Phase
// 3-5 ships; B4-B5 sentinel-escalation contract beats deleted per
// EPIC e-be01fc89 (no orchd analogue at delete time per ADR-211).
//
// Mocks (necessary minimum):
//   - `gitLog` injected → deterministic per-member commit fixtures.
//     The real `defaultGitLog` shells `git -C <path> log` against a
//     worktree; the e2e leans on the same injection point unit tests
//     use (status.test.ts:1082-1109) so the e2e exercises the full
//     classifier + verdict path without committing to disk-resident
//     git history in the test harness.
//   - `sendKeys` injected to lane-stall-tick → records invocation
//     (`atmux claim t-xxx` + Enter to Member-3's window target). No
//     real tmux send. `capture` stub returns READY pane text so
//     `safeSendKeys` doesn't refuse on UNKNOWN.
//   - Discord [ship-zero-window] template renderer — not yet shipped
//     (T5 commit body: "Discord template + medic pickup deferred per
//     the driver's /team rotate-lead at 30% ctx guidance (single
//     focused commit)"). This e2e asserts the verdict-line SHAPE the
//     renderer will produce when it lands per ADR-148 §D6, so the
//     T5-follow-up commit can drop in the renderer with one matching
//     fixture-line. Marked WHEN_RENDERER_LANDS in the assertion.
//
// Out of scope per Task body §Out of scope:
//   - Streak-stability (1x cold-start only).
//   - ML-based cadence-prediction.
//   - Cross-team aggregation (super-driver level).
//
// Beat ↔ scenario mapping (pair runbook beats with rehearsal spec
// steps per CLAUDE.md):
//   B1. Member-1 5min commit  → 🟢 shipping  (D2/D3)
//   B2. Member-2 1h commit    → 🟡 idle      (D2/D3)
//   B3. Member-3 3h commit    → 🚨 ship-zero (D2/D3)
//   B6. Discord [ship-zero-window] template SHAPE (D6 / WHEN_RENDERER_LANDS)
//   B7. lane-stall-tick → fire + send-keys + dedup write (D4)
//   B8. lead wake-nudge brief shape per T4 (D5)
//   B9. backward-compat: cadence.enabled=false → cadence undefined
//   B10. backward-compat: exemptMembers → verdict='exempt'

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux, type TmuxNamespace } from "../../src/abstractions/tmux.ts";
import {
  type CadenceObservation,
  type CadenceThresholds,
  classifyCadence,
  classifyMemberCadence,
} from "../../src/core/cadence-classifier.ts";
import { decideLaneStall, type LaneStallMemberInput } from "../../src/core/lane-stall.ts";
import type { Team } from "../../src/schema/team.ts";
import { runLaneStallTick } from "../../src/verbs/lane-stall-tick.ts";
import { formatCadenceColumn, gatherStatus } from "../../src/verbs/status.ts";

setDefaultTimeout(30_000);

// ---------- shared fixture state (single cold-start+walk) ----------

let teamDir: string;
let atmuxDir: string;
let socketDir: string;
let socketPath: string;
let teamName: string;
let sessionName: string;
let tmux: TmuxNamespace;
let team: Team;
let homeDir: string;
const NOW_MS = 1_780_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const priorEnv: Record<string, string | undefined> = {};

// Default thresholds match ADR-148 §D7 defaults exactly — fixture
// cadence ages are picked relative to these so verdicts are stable
// against the canonical config.
const DEFAULT_THRESHOLDS: CadenceThresholds = {
  shippingMaxAgeSec: 1800, // 30min
  idleMaxAgeSec: 7200, // 2h
  dormantMaxAgeSec: 21600, // 6h
  shipZeroWindowSec: 7200, // 2h
};

beforeAll(async () => {
  teamName = `cad${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  sessionName = teamName; // bare per e-419553c6
  teamDir = await mkdtemp(join(tmpdir(), "atmux-cadence-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  socketDir = `/tmp/atmux-${teamName}`;
  await mkdir(socketDir, { recursive: true });
  socketPath = join(socketDir, "sock");
  homeDir = await mkdtemp(join(tmpdir(), "atmux-cadence-home-"));
  await mkdir(join(homeDir, ".atmux", "state"), { recursive: true });

  // Three lane workers + one gitter. Lanes match Member-3's lane="ops"
  // for the lane-stall beat (B7).
  team = {
    name: teamName,
    members: [
      {
        name: "member-1",
        role: "member",
        lane: "fe",
        emoji: "🐝",
        tui: "shell",
        model: "default",
      },
      {
        name: "member-2",
        role: "member",
        lane: "be",
        emoji: "🐛",
        tui: "shell",
        model: "default",
      },
      {
        name: "member-3",
        role: "member",
        lane: "ops",
        emoji: "🐜",
        tui: "shell",
        model: "default",
      },
      { name: "gitter", role: "gitter", emoji: "🌿", tui: "shell", model: "default" },
    ],
    cadence: {
      enabled: true,
      windowSec: 1800,
      thresholds: DEFAULT_THRESHOLDS,
      laneStallEnabled: true,
      laneStallMinAgeSec: 1800,
      exemptMembers: [],
    },
  } as Team;

  await writeFile(join(atmuxDir, "team.json"), JSON.stringify(team, null, 2));
  // KanbanSchema (src/schema/kanban.ts) requires the top-level epics +
  // stories arrays; bare `{tasks:[]}` would trip zod on first kanban
  // read.
  await writeFile(join(atmuxDir, "kanban.json"), '{"tasks":[],"epics":[],"stories":[]}');

  for (const k of [
    "ATMUX_DIR",
    "ATMUX_TEAM_DIR",
    "ATMUX_SESSION",
    "TMUX",
    "ATMUX_NO_CRON",
    "ATMUX_COCKPIT_CONFIG",
  ]) {
    priorEnv[k] = process.env[k];
  }
  process.env.ATMUX_DIR = atmuxDir;
  process.env.ATMUX_TEAM_DIR = teamDir;
  process.env.ATMUX_NO_CRON = "1";
  // Pin cockpit-config path so probeMedic doesn't reach into the
  // operator's real ~/.atmux/cockpit.json (lifecycle.test.ts same
  // pattern @ status.test.ts:46-47).
  process.env.ATMUX_COCKPIT_CONFIG = join(teamDir, "cockpit-fixture.json");
  delete process.env.ATMUX_SESSION;
  delete process.env.TMUX;

  tmux = createTmux({ socketPath, configFile: "/dev/null" });
});

afterAll(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: server may not have been started for this spec
  }
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(teamDir, { recursive: true, force: true });
  await rm(socketDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

// ---------- helpers ----------

/** Run a sub-action with a labelled error message — same `step` helper
 *  shape lifecycle.test.ts uses (bun:test 1.3 has no native
 *  `test.step`). */
async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Error) e.message = `[step: ${label}] ${e.message}`;
    throw e;
  }
}

/** Per-member commit-fixture. Returns "%H %ct" lines per the
 *  `defaultGitLog` shape so the classifier sees identical input to the
 *  production probe. Keyed on the `author` arg because that's how
 *  `status.ts`'s probe selects the member (`--author=<m.name>`). */
const fixtureGitLog = async (
  _worktreePath: string,
  _sinceSec: number,
  author: string,
): Promise<string[]> => {
  if (author === "member-1") {
    // 5min ago → shipping
    return [`abc1234deadbeefcafe000000000001 ${NOW_SEC - 5 * 60}`];
  }
  if (author === "member-2") {
    // 1h ago, no commit in 30min window → idle (age 3600 < idleMax 7200)
    return [`def5678cafebabe1234000000000002 ${NOW_SEC - 60 * 60}`];
  }
  if (author === "member-3") {
    // 3h ago, no commit in 30min window → ship-zero-window
    // (age 10800 >= shipZeroWindowSec 7200, < dormantMax 21600)
    return [`fed4321beadface5678000000000003 ${NOW_SEC - 3 * 60 * 60}`];
  }
  if (author === "gitter") {
    // 10min ago → shipping
    return [`aaa1111deadbeef0000000000000004 ${NOW_SEC - 10 * 60}`];
  }
  return [];
};

// ---------- sequenced beats ----------

describe("e2e: ADR-148 cadence-truth-signal (1x cold-start+walk)", () => {
  test("B1. Member-1 5min commit → 🟢 shipping (D2/D3)", async () => {
    const obs = await classifyMemberCadence(
      "member-1",
      teamDir,
      { windowSec: 1800, thresholds: DEFAULT_THRESHOLDS },
      { gitLog: fixtureGitLog, nowSec: () => NOW_SEC },
    );
    // `classifyMemberCadence` returns null when the probe could not read a
    // repository at all; a fixture gitLog always can, so a null here would
    // mean the seam broke rather than that the member is quiet.
    expect(obs).not.toBeNull();
    if (obs === null) throw new Error("cadence probe returned null");
    expect(obs.verdict).toBe("shipping");
    expect(obs.commitsInWindow).toBe(1);
    expect(obs.ageOfLastCommitSec).toBe(300);
    expect(formatCadenceColumn(obs)).toBe("commits: 🟢 shipping (5min)");
  });

  test("B2. Member-2 1h commit → 🟡 idle (D2/D3)", async () => {
    const obs = await classifyMemberCadence(
      "member-2",
      teamDir,
      { windowSec: 1800, thresholds: DEFAULT_THRESHOLDS },
      { gitLog: fixtureGitLog, nowSec: () => NOW_SEC },
    );
    // `classifyMemberCadence` returns null when the probe could not read a
    // repository at all; a fixture gitLog always can, so a null here would
    // mean the seam broke rather than that the member is quiet.
    expect(obs).not.toBeNull();
    if (obs === null) throw new Error("cadence probe returned null");
    expect(obs.verdict).toBe("idle");
    expect(obs.commitsInWindow).toBe(0);
    expect(obs.ageOfLastCommitSec).toBe(3600);
    expect(formatCadenceColumn(obs)).toBe("commits: 🟡 idle (1h)");
  });

  test("B3. Member-3 3h commit → 🚨 ship-zero (D2/D3)", async () => {
    const obs = await classifyMemberCadence(
      "member-3",
      teamDir,
      { windowSec: 1800, thresholds: DEFAULT_THRESHOLDS },
      { gitLog: fixtureGitLog, nowSec: () => NOW_SEC },
    );
    // `classifyMemberCadence` returns null when the probe could not read a
    // repository at all; a fixture gitLog always can, so a null here would
    // mean the seam broke rather than that the member is quiet.
    expect(obs).not.toBeNull();
    if (obs === null) throw new Error("cadence probe returned null");
    expect(obs.verdict).toBe("ship-zero-window");
    expect(obs.commitsInWindow).toBe(0);
    expect(obs.ageOfLastCommitSec).toBe(3 * 3600);
    expect(formatCadenceColumn(obs)).toBe("commits: 🚨 ship-zero (3h)");
  });

  test("B3b. atmux status snap → cadence column matches all per-member verdicts (D3)", async () => {
    const snap = await gatherStatus(tmux, team, sessionName, atmuxDir, {
      now: () => NOW_MS,
      gitLog: fixtureGitLog,
    });
    const byName: Record<string, CadenceObservation | undefined> = {};
    for (const m of snap.members) byName[m.name] = m.cadence;
    expect(byName["member-1"]?.verdict).toBe("shipping");
    expect(byName["member-2"]?.verdict).toBe("idle");
    expect(byName["member-3"]?.verdict).toBe("ship-zero-window");
    expect(byName["gitter"]?.verdict).toBe("shipping");
  });

  // B4 + B5 (sentinel-escalation classify contract beats) deleted per
  // EPIC e-be01fc89 — escalation surface removed; orchd-side analogue
  // tracked at e-a946af69. See file-header TODO.

  test("B6. Discord [ship-zero-window] template SHAPE (D6 / WHEN_RENDERER_LANDS)", async () => {
    // T5 deferred the renderer; this beat pins the SHAPE the renderer
    // MUST produce per ADR-148 §D6 so the follow-up commit drops in
    // an implementation with this exact assertion as the regression
    // fixture. Marker: WHEN_RENDERER_LANDS — replace this beat's body
    // with `import { renderShipZeroWindow } from "../../src/abstractions/
    // discord.ts"` + the matching assertion once the named-template
    // ships.
    const member3Cadence = classifyCadence(
      [`fed ${NOW_SEC - 3 * 3600}`],
      NOW_SEC,
      1800,
      DEFAULT_THRESHOLDS,
    );
    expect(member3Cadence.verdict).toBe("ship-zero-window");

    // Verdict-line shape per ADR-148 §D6:
    //   🚨 Need you — <member> ship-zero-window <age> (no commits since <SHA>)
    const verdictLine =
      `🚨 Need you — member-3 ship-zero-window ` +
      `${formatCadenceColumn(member3Cadence).match(/\(([^)]+)\)/)?.[1] ?? ""} ` +
      `(no commits since ${member3Cadence.lastCommitSha ?? "—"})`;
    expect(verdictLine).toContain("🚨 Need you");
    expect(verdictLine).toContain("member-3");
    expect(verdictLine).toContain("ship-zero-window");
    expect(verdictLine).toContain(member3Cadence.lastCommitSha!);
  });

  test("B7. lane-stall-tick → fire + send-keys + dedup write (D4 / T3 integration)", async () => {
    // (a) File a Task in lane=ops with createdAt 31min ago — past the
    //     1800s laneStallMinAgeSec threshold so the age gate trips.
    const staleAgeSec = 31 * 60;
    const staleTaskId = "t-stalecadenc";
    const kanbanText = await readFile(join(atmuxDir, "kanban.json"), "utf8");
    const kanban = JSON.parse(kanbanText) as {
      tasks: unknown[];
      epics: unknown[];
      stories: unknown[];
    };
    kanban.tasks.push({
      id: staleTaskId,
      subject: "synthetic stalled ops task",
      body: "",
      status: "todo",
      owner: null,
      deps: [],
      priority: null,
      lane: "ops",
      createdAt: NOW_SEC - staleAgeSec,
      claimedAt: null,
      completedAt: null,
    });
    await writeFile(join(atmuxDir, "kanban.json"), JSON.stringify(kanban, null, 2));

    // (b) Inject deps: cadence stub maps member-3 → ship-zero-window
    //     (other members shipping). Capture returns READY pane text →
    //     safeSendKeys classifies as READY → opt.sendKeys fires.
    const sendKeysCalls: Array<{ target: string; keys: string; opts?: { enter?: boolean } }> = [];
    const decisions = await runLaneStallTick(team, atmuxDir, {
      cadenceVerdict: async (m) => {
        if (m.name === "member-3") return "ship-zero-window";
        if (m.name === "member-1") return "idle";
        if (m.name === "member-2") return "idle";
        return "shipping";
      },
      capture: async () => "❯\n",
      sendKeys: async (target, keys, opts) => {
        sendKeysCalls.push({
          target,
          keys,
          ...(opts !== undefined ? { opts } : {}),
        });
      },
      nowSec: () => NOW_SEC,
      home: homeDir,
      log: () => {},
    });

    await step("decision is a fire targeted at member-3 (lane=ops owner)", async () => {
      expect(decisions.fired).toBe(1);
      expect(decisions.flagged).toBe(0);
      const fire = decisions.decisions.find((d) => d.kind === "fire");
      expect(fire).toBeDefined();
      expect(fire?.taskId).toBe(staleTaskId);
      expect(fire?.lane).toBe("ops");
      expect(fire?.targetMember).toBe("member-3");
    });

    await step("sendKeys fired with 'atmux claim <task-id>' to member-3 window", async () => {
      expect(sendKeysCalls.length).toBe(1);
      const c = sendKeysCalls[0]!;
      expect(c.keys).toBe(`atmux claim ${staleTaskId}`);
      // window target shape: <sessionName>:<emoji><member> (post-ADR-017)
      expect(c.target).toContain(sessionName);
      expect(c.target).toContain("member-3");
      expect(c.target).toContain("🐜");
    });

    await step("dedup state file written under HOME/.atmux/state", async () => {
      const dedupPath = join(homeDir, ".atmux", "state", "lane-stall-fires.json");
      const text = await readFile(dedupPath, "utf8");
      const dedup = JSON.parse(text) as {
        fires: Array<{ taskId: string; lane: string; firedAt: number }>;
      };
      expect(dedup.fires.length).toBeGreaterThan(0);
      expect(dedup.fires[0]?.taskId).toBe(staleTaskId);
      expect(dedup.fires[0]?.lane).toBe("ops");
    });
  });

  test("B7b. lane-stall-tick decision short-circuits when ANY lane member is shipping", async () => {
    // Pure-function assertion against decideLaneStall — proves the
    // gate-3 (some member shipping) short-circuit per §D4. Uses the
    // same stale Task from B7.
    const decisions = decideLaneStall({
      tasks: [{ id: "t-shippinglane", lane: "ops", createdAt: NOW_SEC - 31 * 60 }],
      members: [
        { name: "member-3", lane: "ops", verdict: "shipping" } satisfies LaneStallMemberInput,
      ],
      dedup: [],
      nowSec: NOW_SEC,
      laneStallMinAgeSec: 1800,
    });
    expect(decisions[0]?.kind).toBe("skip-some-shipping");
  });

  test("B8. lead wake-nudge brief shape per T4 (D5)", async () => {
    // T4 brief lands at templates/briefs/team-lead.md; verify the
    // canonical wake-nudge sentence is present so a lead bootstrapping
    // off the brief produces the exact `atmux send` argv the runbook
    // expects. CLAUDE.md "pair runbook beats with rehearsal spec
    // steps" — the brief sentence IS the runbook beat for D5.
    const _briefPath = join(teamDir, "..", "..", "..", "templates", "briefs", "team-lead.md");
    // Resolve relative to the repo root: this test sits at
    // <repo>/tests/e2e/cadence-truth-signal.test.ts; brief at
    // <repo>/templates/briefs/team-lead.md. import.meta.url gives the
    // test file URL we can step back from for the canonical path.
    const here = new URL(".", import.meta.url).pathname;
    const repoBriefPath = join(here, "..", "..", "templates", "briefs", "team-lead.md");
    const brief = await readFile(repoBriefPath, "utf8");

    await step("brief carries the cadence wake-nudge sentence verbatim", async () => {
      expect(brief).toContain("cadence verdict");
      expect(brief).toContain("What's the blocker?");
    });
    await step("brief references ADR-148 by number", async () => {
      expect(brief).toContain("ADR-148");
    });
    // Also assert that a lead, simulating the brief's behaviour, would
    // compose a valid `atmux send` argv against Member-3's verdict.
    const member3Verdict = "ship-zero-window";
    const member3Age = "3h";
    const composed = `atmux send member-3 "[lead] cadence verdict ${member3Verdict}; last commit ${member3Age}. What's the blocker?"`;
    expect(composed).toContain("[lead] cadence verdict ship-zero-window");
    expect(composed).toContain("What's the blocker?");
  });

  test("B9. backward-compat: cadence.enabled=false → no cadence column", async () => {
    const teamOff: Team = { ...team, cadence: { enabled: false } };
    const snap = await gatherStatus(tmux, teamOff, sessionName, atmuxDir, {
      now: () => NOW_MS,
      gitLog: fixtureGitLog,
    });
    for (const m of snap.members) {
      expect(m.cadence).toBeUndefined();
    }
    // Status renderer says "no signal" when cadence is undefined.
    // It used to render a bare "—". `atmux status`'s text table is what
    // the `team_status` voice tool hands to a model, and a dash read
    // aloud is nothing at all — ADR-273 §Supplement-6 X3.
    expect(formatCadenceColumn(undefined)).toBe("commits: no signal");

    // lane-stall-tick treats cadence.enabled=false as no-op (see verb's
    // team.cadence?.enabled !== true gate at line 162).
    const result = await runLaneStallTick(teamOff, atmuxDir, {
      cadenceVerdict: async () => "ship-zero-window", // would fire if gate didn't trip
      capture: async () => "❯\n",
      sendKeys: async () => {
        throw new Error("send should not be reached with cadence.enabled=false");
      },
      nowSec: () => NOW_SEC,
      home: homeDir,
      log: () => {},
    });
    expect(result.fired).toBe(0);
    expect(result.decisions).toEqual([]);
  });

  test("B10. backward-compat: exemptMembers → verdict='exempt'", async () => {
    // Mark member-3 exempt — the ship-zero-window classifier path
    // should be skipped entirely + the renderer returns "commits: exempt".
    const teamExempt: Team = {
      ...team,
      cadence: {
        ...(team.cadence ?? {}),
        exemptMembers: ["member-3"],
      },
    };
    let gitCallsForMember3 = 0;
    const snap = await gatherStatus(tmux, teamExempt, sessionName, atmuxDir, {
      now: () => NOW_MS,
      gitLog: async (worktreePath, sinceSec, author) => {
        if (author === "member-3") gitCallsForMember3 += 1;
        return await fixtureGitLog(worktreePath, sinceSec, author);
      },
    });
    const m3 = snap.members.find((m) => m.name === "member-3");
    expect(m3?.cadence?.verdict).toBe("exempt");
    // Exempt members short-circuit BEFORE the git-log probe — confirms
    // status.ts:614 exempt branch is honored (no needless git shell out).
    expect(gitCallsForMember3).toBe(0);
    expect(formatCadenceColumn(m3?.cadence)).toBe("commits: exempt");
  });
});
