// E2E budget-pause walk — synthetic high-utilization scenario walks
// pause → resume on the public `whip` verb (ADR-053 §D2).
//
// **Stateful 1x cold-start+walk e2e — sequenced beats consume probe
// outcomes. Don't streak; don't run-of-N. Per CLAUDE.md testing
// discipline §"Stateful e2e specs are not repeatable smokes." Matches
// bash tests/e2e/pause_resume.bats shape (which doesn't exist on this
// branch — bash atmux's pause/resume is whip-internal, not bats-tested
// at the e2e tier). The TS port surfaces the lifecycle through the
// `whip` verb's `budgetProbe` injection point so the walk is purely
// in-process: no real Anthropic API calls, no flaky network.
//
// Beat ↔ @test mapping (one beat per test() per CLAUDE.md "pair
// runbook beats with rehearsal spec steps" rule):
//   1. fresh tick with low utilization  → no pause, no findings
//   2. high-utilization tick            → enter pause; state-file +
//                                         driver-inbox + Discord pause
//                                         ping fire; team members get
//                                         paused.json entries
//   3. still-high tick                  → stay paused; no second pause
//                                         ping; no resume yet
//   4. low-utilization tick             → exit pause; state cleared,
//                                         members resumed, resume ping
//                                         fires
//
// Mocking:
//   - `budgetProbe` injected via WhipOpts to simulate Anthropic
//     responses without hitting the network.
//   - `discordSend` injected to capture template firings.
//   - tmux session UP via `buildFakeTmux`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BudgetProbeResult,
  BudgetProbeStatus,
} from "../../src/abstractions/budget-probe.ts";
import type { DiscordSendOpts, DiscordTemplate } from "../../src/abstractions/discord.ts";
import type { TmuxNamespace } from "../../src/abstractions/tmux.ts";
import { whip } from "../../src/verbs/whip.ts";

// ---------- Fixture builders ----------

/** Minimal TmuxNamespace stub matching the surface used by whip's
 *  per-member checks (session.hasSession, window.listWindows,
 *  pane.{displayMessage,listPanes,capturePane,sendKeys}).
 *  panes: { "<emoji>member": "expected pane_current_command" }. */
function buildFakeTmux(opts: { sessionUp: boolean; panes: Record<string, string> }): TmuxNamespace {
  const tmuxNs: Partial<TmuxNamespace> = {
    session: {
      hasSession: async () => opts.sessionUp,
      newSession: async () => {},
      killSession: async () => {},
      listSessions: async () => [],
      renameSession: async () => {},
    },
    window: {
      listWindows: async () =>
        Object.keys(opts.panes).map((name, i) => ({ index: i, name, active: false })),
      newWindow: async () => ({ sessionName: "x", windowIndex: 0 }),
      killWindow: async () => {},
      renameWindow: async () => {},
      selectWindow: async () => {},
    },
    pane: {
      displayMessage: async (o: { target: unknown; format: string }) => {
        const wn = String(o.target).split(":")[1] ?? "";
        return opts.panes[wn] ?? "";
      },
      listPanes: async (target: unknown) => {
        const wn = String(target).split(":")[1] ?? "";
        if (opts.panes[wn] === undefined) return [];
        return [{ index: 0, pid: 10000, title: "", width: 80, height: 24 }];
      },
      capturePane: async () => "",
      sendKeys: async () => {},
      killPane: async () => {},
      splitWindow: async () => ({ sessionName: "x", windowIndex: 0, paneIndex: 0 }),
    },
    buffer: {
      loadBuffer: async () => {},
      pasteBuffer: async () => {},
      deleteBuffer: async () => {},
    },
    client: {
      attachSession: async () => {},
      switchClient: async () => {},
      listClients: async () => [],
    },
    server: {
      hasServer: async () => true,
      killServer: async () => {},
    },
  };
  return tmuxNs as TmuxNamespace;
}

function probeResult(overrides: Partial<BudgetProbeResult> & { account: string }): BudgetProbeResult {
  return {
    account: overrides.account,
    h5_pct_used: overrides.h5_pct_used ?? 0,
    wk_pct_used: overrides.wk_pct_used ?? 0,
    h5_reset_epoch: overrides.h5_reset_epoch ?? 0,
    wk_reset_epoch: overrides.wk_reset_epoch ?? 0,
    status: overrides.status ?? ("allowed" as BudgetProbeStatus),
    source: overrides.source ?? "probe",
    probedAt: overrides.probedAt ?? Math.floor(Date.now() / 1000),
  };
}

const TEAM_FIXTURE = {
  name: "demo",
  members: [
    {
      name: "alpha",
      role: "team-lead",
      tui: "claude",
      claudeAccount: "ifca",
      emoji: "🧭",
    },
    {
      name: "bravo",
      role: "member",
      tui: "claude",
      claudeAccount: "ifca",
      emoji: "🐝",
    },
  ],
  whip: {
    budgetPauseThreshold: 90,
    budgetResumeThreshold: 80,
    budgetWarningBands: [0.5, 0.25, 0.15],
    budgetRefreshLeadMins: 30,
  },
};

// ---------- Walk ----------

describe("e2e budget-pause walk (ADR-053 §D2)", () => {
  let teamDir: string;
  let atmuxDir: string;
  let homeDir: string;
  // Capture sinks across the walk.
  let stdoutBuf: string;
  let stderrBuf: string;
  const stdout = (s: string): void => {
    stdoutBuf += s;
  };
  const stderr = (s: string): void => {
    stderrBuf += s;
  };
  // Per-beat probe controller — each beat assigns the next probe outcome.
  let probeOutcome: BudgetProbeResult;
  // Per-beat Discord capture.
  let discordSent: DiscordSendOpts[];

  const probeFn = async (account: string): Promise<BudgetProbeResult> => {
    return { ...probeOutcome, account };
  };
  const discordSend = async (opts: DiscordSendOpts): Promise<void> => {
    discordSent.push(opts);
  };

  /** One whip tick at the given clock + with the given probe outcome. */
  async function tick(nowMsAt: number, outcome: BudgetProbeResult): Promise<number> {
    probeOutcome = outcome;
    discordSent = [];
    stdoutBuf = "";
    stderrBuf = "";
    return await whip(["--team-dir", teamDir], {
      stdout,
      stderr,
      now: () => nowMsAt,
      home: homeDir,
      env: {},
      tmux: buildFakeTmux({
        sessionUp: true,
        panes: { "🧭alpha": "claude", "🐝bravo": "claude" },
      }),
      discordSend,
      budgetProbe: probeFn,
    });
  }

  beforeEach(async () => {
    teamDir = await mkdtemp(join(tmpdir(), "atmux-e2e-pause-"));
    atmuxDir = join(teamDir, ".atmux");
    homeDir = await mkdtemp(join(tmpdir(), "atmux-e2e-home-"));
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify(TEAM_FIXTURE));
    stdoutBuf = "";
    stderrBuf = "";
    probeOutcome = probeResult({ account: "ifca" });
    discordSent = [];
  });

  afterEach(async () => {
    await rm(teamDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  test("Beat 1 — low utilization: no pause, no findings", async () => {
    const exit = await tick(
      1_700_000_000_000,
      probeResult({
        account: "ifca",
        h5_pct_used: 30,
        wk_pct_used: 25,
        h5_reset_epoch: Math.floor(1_700_000_000_000 / 1000) + 60 * 60 * 4,
        wk_reset_epoch: Math.floor(1_700_000_000_000 / 1000) + 60 * 60 * 24 * 6,
      }),
    );
    expect(exit).toBe(0);
    // No pause state file written.
    const pauseStatePath = join(atmuxDir, "state", "budget-pause.json");
    await expect(readFile(pauseStatePath, "utf8")).rejects.toThrow();
    // No pause Discord ping fired.
    expect(discordSent.find((d) => d.template === "whip-budget-pause")).toBeUndefined();
  });

  test("Beat 2 — high utilization: enter pause", async () => {
    // Pre-condition assertion: a baseline low tick to ensure clean state.
    await tick(
      1_700_000_000_000,
      probeResult({ account: "ifca", h5_pct_used: 30, wk_pct_used: 25 }),
    );

    const exit = await tick(
      1_700_000_300_000, // 5min later
      probeResult({
        account: "ifca",
        h5_pct_used: 95, // above pause threshold (90)
        wk_pct_used: 60,
        h5_reset_epoch: Math.floor(1_700_000_300_000 / 1000) + 60 * 60 * 4,
        wk_reset_epoch: Math.floor(1_700_000_300_000 / 1000) + 60 * 60 * 24 * 6,
      }),
    );
    expect(exit).toBe(0);

    // Pause state file exists with at-risk members listed.
    const pauseStatePath = join(atmuxDir, "state", "budget-pause.json");
    const pauseState = JSON.parse(await readFile(pauseStatePath, "utf8"));
    expect(pauseState.paused).toBe(true);
    expect(pauseState.atRisk).toHaveLength(2); // both members on ifca account
    expect(pauseState.atRisk.map((r: { member: string }) => r.member).sort()).toEqual([
      "alpha",
      "bravo",
    ]);

    // Both team members marked paused.
    const pausedPath = join(atmuxDir, "state", "paused.json");
    const pausedMap = JSON.parse(await readFile(pausedPath, "utf8"));
    expect(Object.keys(pausedMap).sort()).toEqual(["alpha", "bravo"]);
    expect(pausedMap.alpha.reason).toBe("budget-low");

    // Driver-inbox got the pause entry.
    const di = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(di).toContain("🪫 budget-pause entered");
    expect(di).toContain("alpha: 5h 95%");
    expect(di).toContain("bravo: 5h 95%");

    // Discord pause ping fired.
    const pausePing = discordSent.find((d) => d.template === "whip-budget-pause");
    expect(pausePing).toBeDefined();
  });

  test("Beat 3 — still-high tick after pause: stay paused, no second ping", async () => {
    // Beat 2 setup.
    await tick(
      1_700_000_000_000,
      probeResult({ account: "ifca", h5_pct_used: 30, wk_pct_used: 25 }),
    );
    await tick(
      1_700_000_300_000,
      probeResult({ account: "ifca", h5_pct_used: 95, wk_pct_used: 60 }),
    );

    // Beat 3 — utilization still high.
    const exit = await tick(
      1_700_000_600_000, // another 5min
      probeResult({ account: "ifca", h5_pct_used: 92, wk_pct_used: 60 }),
    );
    expect(exit).toBe(0);

    // Pause state still present.
    const pauseStatePath = join(atmuxDir, "state", "budget-pause.json");
    const pauseState = JSON.parse(await readFile(pauseStatePath, "utf8"));
    expect(pauseState.paused).toBe(true);

    // No second pause ping fired this tick.
    expect(discordSent.find((d) => d.template === "whip-budget-pause")).toBeUndefined();
    // No resume ping yet either.
    expect(discordSent.find((d) => d.template === "whip-budget-resume")).toBeUndefined();
  });

  test("Beat 4 — low-utilization tick: exit pause, resume team", async () => {
    // Beat 2 setup — enter pause.
    await tick(
      1_700_000_000_000,
      probeResult({ account: "ifca", h5_pct_used: 30, wk_pct_used: 25 }),
    );
    await tick(
      1_700_000_300_000,
      probeResult({ account: "ifca", h5_pct_used: 95, wk_pct_used: 60 }),
    );

    // Beat 4 — utilization back below resume threshold (≤80% used on
    // BOTH windows).
    const exit = await tick(
      1_700_000_600_000,
      probeResult({ account: "ifca", h5_pct_used: 70, wk_pct_used: 50 }),
    );
    expect(exit).toBe(0);

    // Pause state cleared.
    const pauseStatePath = join(atmuxDir, "state", "budget-pause.json");
    await expect(readFile(pauseStatePath, "utf8")).rejects.toThrow();

    // Members resumed.
    const pausedPath = join(atmuxDir, "state", "paused.json");
    const pausedMap = JSON.parse(await readFile(pausedPath, "utf8"));
    expect(pausedMap).toEqual({});

    // Driver-inbox got the resume entry.
    const di = await readFile(join(atmuxDir, "driver-inbox.md"), "utf8");
    expect(di).toContain("🟢 budget-pause cleared");

    // Discord resume ping fired.
    const resumePing = discordSent.find((d) => d.template === "whip-budget-resume");
    expect(resumePing).toBeDefined();
  });

  test("Hysteresis — wk above resume threshold but below pause threshold: stays paused", async () => {
    await tick(
      1_700_000_000_000,
      probeResult({ account: "ifca", h5_pct_used: 30, wk_pct_used: 25 }),
    );
    await tick(
      1_700_000_300_000,
      probeResult({ account: "ifca", h5_pct_used: 95, wk_pct_used: 60 }),
    );
    // h5 fell to 85%, wk still at 60% — within the 80-90 hysteresis band.
    // ALL accounts must be ≤80% on BOTH windows to resume; 85 > 80 →
    // stay paused.
    const exit = await tick(
      1_700_000_600_000,
      probeResult({ account: "ifca", h5_pct_used: 85, wk_pct_used: 60 }),
    );
    expect(exit).toBe(0);

    const pauseStatePath = join(atmuxDir, "state", "budget-pause.json");
    const pauseState = JSON.parse(await readFile(pauseStatePath, "utf8"));
    expect(pauseState.paused).toBe(true);
    // No resume ping.
    expect(discordSent.find((d) => d.template === "whip-budget-resume")).toBeUndefined();
  });

  test("Mode B coordination — pause-active tick early-returns BEFORE per-member checks", async () => {
    // Enter pause first.
    await tick(
      1_700_000_300_000,
      probeResult({ account: "ifca", h5_pct_used: 95, wk_pct_used: 60 }),
    );
    // Now run a pause-active tick. The verb should early-return; member
    // panes don't even get inspected for stale-task / Compacting / etc.
    // Assertion: no `whip-progress` template fires (the heartbeat /
    // findings tick payload). Discord traffic this tick is empty.
    const exit = await tick(
      1_700_000_600_000,
      probeResult({ account: "ifca", h5_pct_used: 92, wk_pct_used: 60 }),
    );
    expect(exit).toBe(0);
    // No regular-tick Discord output (heartbeat or progress) — those
    // would only fire AFTER the budget early-return.
    const allowedTemplates: ReadonlyArray<DiscordTemplate> = [
      "whip-budget-pause",
      "whip-budget-resume",
      "whip-budget-warning",
      "whip-budget-refresh-soon",
    ];
    for (const sent of discordSent) {
      expect(allowedTemplates).toContain(sent.template);
    }
  });
});
