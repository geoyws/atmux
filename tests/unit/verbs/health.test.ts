// Unit tests for src/verbs/health.ts (SPEC-066 / t-c2cd08b1).
//
// Coverage strategy
// -----------------
// Pure helpers (`parseHealthArgs`, `uniqueClaudeAccounts`,
// `renderTextHealth`) are exercised directly. `gatherHealth` runs
// against a real cage-isolated tmux + fixture team.json, with
// heartbeat files staged on disk and the budget probe stubbed via
// `GatherHealthDeps.probeBudget`. The verb entry (`health`) is driven
// end-to-end with stdout captured.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetProbeResult } from "../../../src/abstractions/budget-probe.ts";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { writeHeartbeat } from "../../../src/core/heartbeat.ts";
import { addTask, moveTask } from "../../../src/core/kanban.ts";
import { UsageError } from "../../../src/errors.ts";
import type { Team } from "../../../src/schema/team.ts";
import {
  gatherHealth,
  health,
  parseHealthArgs,
  renderTextHealth,
  uniqueClaudeAccounts,
} from "../../../src/verbs/health.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

let socketDir: string;
let socketPath: string;
let teamDir: string;
let atmuxDir: string;
let homeDir: string;
let priorTmux: string | undefined;
let priorCockpitConfig: string | undefined;
let tmux: TmuxNamespace;
let sessionPrefix: string;
let cockpitConfigPath: string;
let restoreHome: (() => void) | null = null;

beforeEach(async () => {
  socketDir = await mkdtemp(join(tmpdir(), "atmux-health-sock-"));
  socketPath = join(socketDir, "sock");
  teamDir = await mkdtemp(join(tmpdir(), "atmux-health-team-"));
  homeDir = await mkdtemp(join(tmpdir(), "atmux-health-home-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  priorTmux = process.env.TMUX;
  delete process.env.TMUX;
  priorCockpitConfig = process.env.ATMUX_COCKPIT_CONFIG;
  cockpitConfigPath = join(teamDir, "cockpit-fixture.json");
  process.env.ATMUX_COCKPIT_CONFIG = cockpitConfigPath;
  restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
  tmux = createCanonicalAtmuxTmux({ socketPath });
});

afterEach(async () => {
  try {
    await tmux.server.killServer();
  } catch {
    // expected: idempotent teardown
  }
  restoreHome?.();
  restoreHome = null;
  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  else delete process.env.TMUX;
  if (priorCockpitConfig !== undefined) {
    process.env.ATMUX_COCKPIT_CONFIG = priorCockpitConfig;
  } else {
    delete process.env.ATMUX_COCKPIT_CONFIG;
  }
  await rm(socketDir, { recursive: true, force: true });
  await rm(teamDir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
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

interface StageMember {
  name: string;
  role?: string;
  tui?: string;
  emoji?: string;
  claudeAccount?: string;
}

async function stageTeam(
  members: ReadonlyArray<StageMember>,
  withSession: boolean,
): Promise<{ teamName: string; sessionName: string }> {
  const teamName = `${sessionPrefix}-team`;
  const sessionName = teamName; // bare per e-419553c6
  await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: teamName, members }));
  if (withSession) {
    const first = members[0];
    if (first === undefined) throw new Error("test fail");
    const winName =
      first.emoji !== undefined && first.emoji.length > 0
        ? `${first.emoji}${first.name}`
        : first.name;
    await tmux.session.newSession({
      name: sessionName,
      shellCommand: "cat",
      windowName: winName,
    });
    for (const m of members.slice(1)) {
      const wn = m.emoji !== undefined && m.emoji.length > 0 ? `${m.emoji}${m.name}` : m.name;
      await tmux.window.newWindow({ sessionName, name: wn, shellCommand: "cat" });
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return { teamName, sessionName };
}

// ---------- parseHealthArgs ----------

describe("parseHealthArgs", () => {
  test("empty argv → defaults", () => {
    const a = parseHealthArgs([]);
    expect(a.json).toBe(true);
    expect(a.text).toBe(false);
    expect(a.includeBudget).toBe(false);
    expect(a.staleSec).toBe(300);
  });

  test("--text flips json off", () => {
    const a = parseHealthArgs(["--text"]);
    expect(a.text).toBe(true);
    expect(a.json).toBe(false);
  });

  test("--text then --json — json wins (last-flag-wins is too clever; explicit --json restores)", () => {
    const a = parseHealthArgs(["--text", "--json"]);
    expect(a.json).toBe(true);
    expect(a.text).toBe(false);
  });

  test("--budget enables probe", () => {
    expect(parseHealthArgs(["--budget"]).includeBudget).toBe(true);
  });

  test("--stale-sec parses positive int", () => {
    expect(parseHealthArgs(["--stale-sec", "120"]).staleSec).toBe(120);
  });

  test("--stale-sec 0 accepted (immediate staleness)", () => {
    expect(parseHealthArgs(["--stale-sec", "0"]).staleSec).toBe(0);
  });

  test("--stale-sec without value → UsageError", () => {
    expect(() => parseHealthArgs(["--stale-sec"])).toThrow(UsageError);
  });

  test("--stale-sec with non-numeric → UsageError", () => {
    expect(() => parseHealthArgs(["--stale-sec", "soon"])).toThrow(UsageError);
  });

  test("--stale-sec negative → UsageError", () => {
    expect(() => parseHealthArgs(["--stale-sec", "-1"])).toThrow(UsageError);
  });

  test("--socket / --team-dir captured", () => {
    const a = parseHealthArgs(["--socket", "/s", "--team-dir", "/x"]);
    expect(a.socketPath).toBe("/s");
    expect(a.teamDir).toBe("/x");
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseHealthArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseHealthArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown arg → UsageError", () => {
    expect(() => parseHealthArgs(["bogus"])).toThrow(UsageError);
    expect(() => parseHealthArgs(["--bogus"])).toThrow(UsageError);
  });
});

// ---------- uniqueClaudeAccounts ----------

describe("uniqueClaudeAccounts", () => {
  test("empty roster → []", () => {
    expect(uniqueClaudeAccounts({ name: "t", members: [] } as Team)).toEqual([]);
  });

  test("roster with no claudeAccount fields → []", () => {
    const team: Team = { name: "t", members: [{ name: "a" }, { name: "b" }] };
    expect(uniqueClaudeAccounts(team)).toEqual([]);
  });

  test("dedupes while preserving first-seen order", () => {
    const team = {
      name: "t",
      members: [
        { name: "a", claudeAccount: "personal" },
        { name: "b", claudeAccount: "ifca" },
        { name: "c", claudeAccount: "personal" },
        { name: "d" },
        { name: "e", claudeAccount: "icloud" },
      ],
    } as unknown as Team;
    expect(uniqueClaudeAccounts(team)).toEqual(["personal", "ifca", "icloud"]);
  });

  test("ignores empty-string and non-string values", () => {
    const team = {
      name: "t",
      members: [
        { name: "a", claudeAccount: "" },
        { name: "b", claudeAccount: 42 },
        { name: "c", claudeAccount: "real" },
      ],
    } as unknown as Team;
    expect(uniqueClaudeAccounts(team)).toEqual(["real"]);
  });
});

// ---------- gatherHealth ----------

describe("gatherHealth", () => {
  test("session down: members report (down) pane + null heartbeat", async () => {
    const { teamName, sessionName } = await stageTeam(
      [{ name: "alpha", role: "member", tui: "claude" }],
      false,
    );
    const team: Team = {
      name: teamName,
      members: [{ name: "alpha", role: "member", tui: "claude" }],
    };
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: false, staleSec: 300 },
      { nowSec: () => 1_000_000 },
    );
    expect(snap.sessionState).toBe("down");
    expect(snap.generatedAt).toBe(1_000_000);
    expect(snap.staleSec).toBe(300);
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0]).toEqual({
      name: "alpha",
      role: "member",
      tui: "claude",
      paneCommand: "(down)",
      pendingCount: 0,
      inProgressCount: 0,
      heartbeatAgeSec: null,
      heartbeatStale: true,
    });
    expect(snap.budget).toEqual([]);
  });

  test("fresh heartbeat → heartbeatStale=false", async () => {
    const { teamName, sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team: Team = { name: teamName, members: [{ name: "alpha" }] };
    await writeHeartbeat(atmuxDir, "alpha", 1_000_000 - 30); // 30s old
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: false, staleSec: 300 },
      { nowSec: () => 1_000_000 },
    );
    expect(snap.members[0]?.heartbeatAgeSec).toBe(30);
    expect(snap.members[0]?.heartbeatStale).toBe(false);
  });

  test("stale heartbeat → heartbeatStale=true", async () => {
    const { teamName, sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team: Team = { name: teamName, members: [{ name: "alpha" }] };
    await writeHeartbeat(atmuxDir, "alpha", 1_000_000 - 600); // 600s old, staleSec=300
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: false, staleSec: 300 },
      { nowSec: () => 1_000_000 },
    );
    expect(snap.members[0]?.heartbeatAgeSec).toBe(600);
    expect(snap.members[0]?.heartbeatStale).toBe(true);
  });

  test("emoji passes through when present on the roster member", async () => {
    const { teamName, sessionName } = await stageTeam([{ name: "alpha", emoji: "🐝" }], false);
    const team: Team = {
      name: teamName,
      members: [{ name: "alpha", emoji: "🐝" }],
    };
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: false, staleSec: 300 },
      { nowSec: () => 1_000_000 },
    );
    expect(snap.members[0]?.emoji).toBe("🐝");
  });

  test("kanban counts roll up across all statuses", async () => {
    const { teamName, sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team: Team = { name: teamName, members: [{ name: "alpha" }] };
    await addTask(atmuxDir, { subject: "t1" });
    await addTask(atmuxDir, { subject: "t2" });
    const ipId = await addTask(atmuxDir, { subject: "ip" });
    await moveTask(atmuxDir, ipId, "in-progress");
    const doneId = await addTask(atmuxDir, { subject: "done" });
    await moveTask(atmuxDir, doneId, "done");
    const blockedId = await addTask(atmuxDir, { subject: "b" });
    await moveTask(atmuxDir, blockedId, "blocked");
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: false, staleSec: 300 },
      { nowSec: () => 1_000_000 },
    );
    expect(snap.kanban).toEqual({ todo: 2, inProgress: 1, done: 1, blocked: 1 });
  });

  test("--budget probes each unique account once", async () => {
    const { teamName, sessionName } = await stageTeam(
      [
        { name: "a", claudeAccount: "personal" },
        { name: "b", claudeAccount: "personal" }, // dup
        { name: "c", claudeAccount: "ifca" },
      ],
      false,
    );
    const team = {
      name: teamName,
      members: [
        { name: "a", claudeAccount: "personal" },
        { name: "b", claudeAccount: "personal" },
        { name: "c", claudeAccount: "ifca" },
      ],
    } as unknown as Team;
    const probedAccounts: string[] = [];
    const fakeProbe = async (account: string): Promise<BudgetProbeResult> => {
      probedAccounts.push(account);
      return {
        account,
        h5_pct_used: 42,
        wk_pct_used: 11,
        h5_reset_epoch: 0,
        wk_reset_epoch: 0,
        status: "allowed",
        source: "probe",
        probedAt: 1_000_000,
      };
    };
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: true, staleSec: 300 },
      { nowSec: () => 1_000_000, probeBudget: fakeProbe },
    );
    expect(probedAccounts).toEqual(["personal", "ifca"]);
    expect(snap.budget.map((b) => b.account)).toEqual(["personal", "ifca"]);
    expect(snap.budget[0]?.result.h5_pct_used).toBe(42);
  });

  test("budget probe throw is swallowed — bad account doesn't take down snapshot", async () => {
    const { teamName, sessionName } = await stageTeam(
      [
        { name: "a", claudeAccount: "bad" },
        { name: "b", claudeAccount: "good" },
      ],
      false,
    );
    const team = {
      name: teamName,
      members: [
        { name: "a", claudeAccount: "bad" },
        { name: "b", claudeAccount: "good" },
      ],
    } as unknown as Team;
    const fakeProbe = async (account: string): Promise<BudgetProbeResult> => {
      if (account === "bad") throw new Error("network exploded");
      return {
        account,
        h5_pct_used: 0,
        wk_pct_used: 0,
        h5_reset_epoch: 0,
        wk_reset_epoch: 0,
        status: "allowed",
        source: "probe",
        probedAt: 1_000_000,
      };
    };
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: true, staleSec: 300 },
      { nowSec: () => 1_000_000, probeBudget: fakeProbe },
    );
    expect(snap.budget.map((b) => b.account)).toEqual(["good"]);
  });

  test("includeBudget=true with no claudeAccount in roster → budget stays empty + no probe calls", async () => {
    const { teamName, sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team: Team = { name: teamName, members: [{ name: "alpha" }] };
    let calls = 0;
    const fakeProbe = async (): Promise<BudgetProbeResult> => {
      calls += 1;
      return {
        account: "",
        h5_pct_used: 0,
        wk_pct_used: 0,
        h5_reset_epoch: 0,
        wk_reset_epoch: 0,
        status: "no-credentials",
        source: "probe",
        probedAt: 0,
      };
    };
    const snap = await gatherHealth(
      tmux,
      team,
      sessionName,
      atmuxDir,
      { includeBudget: true, staleSec: 300 },
      { nowSec: () => 1_000_000, probeBudget: fakeProbe },
    );
    expect(calls).toBe(0);
    expect(snap.budget).toEqual([]);
  });

  test("default nowSec branch runs (no injection)", async () => {
    const { teamName, sessionName } = await stageTeam([{ name: "alpha" }], false);
    const team: Team = { name: teamName, members: [{ name: "alpha" }] };
    const snap = await gatherHealth(tmux, team, sessionName, atmuxDir, {
      includeBudget: false,
      staleSec: 300,
    });
    expect(snap.generatedAt).toBeGreaterThan(0);
  });
});

// ---------- health verb integration ----------

describe("health verb — integration", () => {
  test("default → JSON to stdout with composed shape", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      health(["--socket", socketPath, "--team-dir", teamDir], {
        gatherDeps: { nowSec: () => 1_000_000 },
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.team).toMatch(/-team$/);
    expect(parsed.sessionState).toBe("down");
    expect(parsed.generatedAt).toBe(1_000_000);
    expect(parsed.staleSec).toBe(300);
    expect(parsed.members[0]?.heartbeatStale).toBe(true);
    expect(parsed.kanban).toEqual({ todo: 0, inProgress: 0, done: 0, blocked: 0 });
    expect(parsed.driverInboxOpen).toBe(0);
    expect(parsed.budget).toEqual([]);
  });

  test("--text → renders one line per member with hb=neverSTALE", async () => {
    await stageTeam([{ name: "alpha", role: "member", tui: "claude" }], false);
    const { out } = await captureStdout(() =>
      health(["--text", "--socket", socketPath, "--team-dir", teamDir], {
        gatherDeps: { nowSec: () => 1_000_000 },
      }),
    );
    expect(out).toContain("team=");
    expect(out).toContain("[down]");
    expect(out).toContain("alpha");
    expect(out).toContain("hb=never");
    expect(out).toContain("STALE");
  });

  test("--budget injects probe results into JSON", async () => {
    await stageTeam([{ name: "alpha", claudeAccount: "personal" }], false);
    const fakeProbe = async (account: string): Promise<BudgetProbeResult> => ({
      account,
      h5_pct_used: 17,
      wk_pct_used: 4,
      h5_reset_epoch: 1_000_000 + 3600,
      wk_reset_epoch: 1_000_000 + 86400,
      status: "allowed",
      source: "probe",
      probedAt: 1_000_000,
    });
    const { out } = await captureStdout(() =>
      health(["--budget", "--socket", socketPath, "--team-dir", teamDir], {
        gatherDeps: { nowSec: () => 1_000_000, probeBudget: fakeProbe },
      }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.budget).toHaveLength(1);
    expect(parsed.budget[0]).toEqual({
      account: "personal",
      result: {
        account: "personal",
        h5_pct_used: 17,
        wk_pct_used: 4,
        h5_reset_epoch: 1_000_000 + 3600,
        wk_reset_epoch: 1_000_000 + 86400,
        status: "allowed",
        source: "probe",
        probedAt: 1_000_000,
      },
    });
  });

  test("--budget --text renders budget rows", async () => {
    await stageTeam([{ name: "alpha", claudeAccount: "personal" }], false);
    const fakeProbe = async (account: string): Promise<BudgetProbeResult> => ({
      account,
      h5_pct_used: 88,
      wk_pct_used: 33,
      h5_reset_epoch: 0,
      wk_reset_epoch: 0,
      status: "allowed",
      source: "probe",
      probedAt: 1_000_000,
    });
    const { out } = await captureStdout(() =>
      health(["--text", "--budget", "--socket", socketPath, "--team-dir", teamDir], {
        gatherDeps: { nowSec: () => 1_000_000, probeBudget: fakeProbe },
      }),
    );
    expect(out).toContain("budget");
    expect(out).toContain("account=personal");
    expect(out).toContain("h5=88%");
    expect(out).toContain("wk=33%");
  });

  test("default buildTmux branch runs when no opts.buildTmux injected (socket override stays honored)", async () => {
    await stageTeam([{ name: "alpha" }], false);
    const { out } = await captureStdout(() =>
      health(["--socket", socketPath, "--team-dir", teamDir]),
    );
    const parsed = JSON.parse(out);
    expect(parsed.sessionState).toBe("down");
  });
});

// ---------- renderTextHealth ----------

describe("renderTextHealth", () => {
  test("fresh heartbeat row has no STALE marker", () => {
    const txt = renderTextHealth({
      team: "t",
      session: "atmux-t",
      sessionState: "up",
      generatedAt: 1_000_000,
      staleSec: 300,
      members: [
        {
          name: "alpha",
          role: "member",
          tui: "claude",
          paneCommand: "claude",
          pendingCount: 0,
          inProgressCount: 1,
          heartbeatAgeSec: 30,
          heartbeatStale: false,
        },
      ],
      kanban: { todo: 0, inProgress: 1, done: 5, blocked: 0 },
      driverInboxOpen: 0,
      budget: [],
    });
    expect(txt).toContain("hb=30s");
    expect(txt).not.toContain("STALE");
    expect(txt).toContain("[up]");
    expect(txt).toContain("in-progress=1");
  });

  test("budget row omitted when budget array empty", () => {
    const txt = renderTextHealth({
      team: "t",
      session: "atmux-t",
      sessionState: "down",
      generatedAt: 0,
      staleSec: 300,
      members: [],
      kanban: { todo: 0, inProgress: 0, done: 0, blocked: 0 },
      driverInboxOpen: 0,
      budget: [],
    });
    expect(txt).not.toContain("account=");
  });
});
