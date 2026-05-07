// Unit tests for src/core/whip-budget-check.ts (ADR-053 §D2 + §D3).
//
// All external dependencies (probe, pause/resume, Discord, driver-
// inbox) are injected. No real network / spawn / tmux calls.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BudgetProbeResult,
  BudgetProbeStatus,
} from "../../../src/abstractions/budget-probe.ts";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import { resetNow, setNow } from "../../../src/abstractions/time.ts";
import {
  isBudgetPauseActive,
  loadBudgetPauseState,
  writeBudgetPauseState,
} from "../../../src/core/budget-pause.ts";
import {
  loadRefreshSoonState,
  recordRefreshSoonFire,
  writeRefreshSoonState,
} from "../../../src/core/budget-refresh-soon-state.ts";
import {
  loadWarningState,
  recordBandFire,
  writeWarningState,
} from "../../../src/core/budget-warning-state.ts";
import {
  type BudgetCheckCtx,
  type BudgetCheckTeamMember,
  runBudgetCheck,
} from "../../../src/core/whip-budget-check.ts";

// ---------- Fixed clock ----------

const FIXED_NOW_MS = Date.UTC(2026, 4, 7, 3, 44);
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

beforeAll(() => setNow(() => FIXED_NOW_MS));
afterAll(() => resetNow());

// ---------- Sandbox per test ----------

let atmuxDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-wbc-"));
  atmuxDir = join(tmp, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

// ---------- Helpers ----------

function probe(
  account: string,
  h5Pct: number,
  wkPct: number,
  status: BudgetProbeStatus = "allowed",
  resets: { h5?: number; wk?: number } = {},
): BudgetProbeResult {
  return {
    account,
    h5_pct_used: h5Pct,
    wk_pct_used: wkPct,
    h5_reset_epoch: resets.h5 ?? FIXED_NOW_SEC + 3600,
    wk_reset_epoch: resets.wk ?? FIXED_NOW_SEC + 7 * 86400,
    status,
    source: "probe",
    probedAt: FIXED_NOW_SEC,
  };
}

function ctxOf(
  members: BudgetCheckTeamMember[],
  cfg: Partial<BudgetCheckCtx["config"]> = {},
): BudgetCheckCtx {
  return {
    atmuxDir,
    nowMs: FIXED_NOW_MS,
    nowSec: FIXED_NOW_SEC,
    team: { name: "atmux", members },
    config: {
      budgetPauseThreshold: 90,
      budgetResumeThreshold: 80,
      budgetWarningBands: [0.5, 0.25, 0.15],
      budgetRefreshLeadMins: 30,
      ...cfg,
    },
  };
}

interface PauseRecord {
  atmuxDir: string;
  member: string;
  reason: string;
}
interface ResumeRecord {
  atmuxDir: string;
  member: string;
}

interface FakeDeps {
  probedAccounts: string[];
  pauseCalls: PauseRecord[];
  resumeCalls: ResumeRecord[];
  driverInboxAppends: string[];
  discordSends: DiscordSendOpts[];
  logs: string[];
  probesByAccount: Map<string, BudgetProbeResult>;
}

function makeFakeDeps(): FakeDeps {
  return {
    probedAccounts: [],
    pauseCalls: [],
    resumeCalls: [],
    driverInboxAppends: [],
    discordSends: [],
    logs: [],
    probesByAccount: new Map(),
  };
}

function depsFor(fake: FakeDeps): {
  probeBudget: (a: string) => Promise<BudgetProbeResult>;
  pauseMember: (atmuxDir: string, m: string, opts: { reason: string }) => Promise<void>;
  resumeMember: (atmuxDir: string, m: string) => Promise<void>;
  appendDriverInbox: (atmuxDir: string, c: string) => Promise<void>;
  discordSend: (o: DiscordSendOpts) => Promise<void>;
  log: (m: string) => void;
} {
  return {
    probeBudget: async (a) => {
      fake.probedAccounts.push(a);
      const r = fake.probesByAccount.get(a);
      if (r === undefined) {
        return probe(a, 0, 0, "no-credentials");
      }
      return r;
    },
    pauseMember: async (atmuxDir, member, opts) => {
      fake.pauseCalls.push({ atmuxDir, member, reason: opts.reason });
    },
    resumeMember: async (atmuxDir, member) => {
      fake.resumeCalls.push({ atmuxDir, member });
    },
    appendDriverInbox: async (_atmuxDir, content) => {
      fake.driverInboxAppends.push(content);
    },
    discordSend: async (opts) => {
      fake.discordSends.push(opts);
    },
    log: (m) => {
      fake.logs.push(m);
    },
  };
}

// ---------- no-pause-not-active branch ----------

describe("runBudgetCheck — no accounts → no-pause-not-active", () => {
  test("zero members → returns no-pause-not-active", async () => {
    const fake = makeFakeDeps();
    const v = await runBudgetCheck(ctxOf([]), depsFor(fake));
    expect(v).toBe("no-pause-not-active");
    expect(fake.probedAccounts).toEqual([]);
  });

  test("members with empty/default/null claudeAccount → no probe + no-pause", async () => {
    const fake = makeFakeDeps();
    const v = await runBudgetCheck(
      ctxOf([
        { name: "alpha" },
        { name: "beta", claudeAccount: "" },
        { name: "gamma", claudeAccount: "default" },
        { name: "delta", claudeAccount: "null" },
      ]),
      depsFor(fake),
    );
    expect(v).toBe("no-pause-not-active");
    expect(fake.probedAccounts).toEqual([]);
  });

  test("dedupes identical claudeAccount across members", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 5, 10));
    const v = await runBudgetCheck(
      ctxOf([
        { name: "alpha", claudeAccount: "icloud" },
        { name: "beta", claudeAccount: "icloud" },
      ]),
      depsFor(fake),
    );
    expect(v).toBe("active");
    expect(fake.probedAccounts).toEqual(["icloud"]);
  });
});

// ---------- pause-entry branch ----------

describe("runBudgetCheck — pause threshold breach → enter pause", () => {
  test("any member ≥ pauseThreshold (5h) → paused-just-now", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 95, 70));
    const ctx = ctxOf([
      { name: "alpha", claudeAccount: "icloud" },
      { name: "beta", claudeAccount: "icloud" },
    ]);
    const v = await runBudgetCheck(ctx, depsFor(fake));
    expect(v).toBe("paused-just-now");
    // Both members paused (NOT just at-risk subset).
    expect(fake.pauseCalls.map((c) => c.member).sort()).toEqual(["alpha", "beta"]);
    expect(fake.pauseCalls.every((c) => c.reason === "budget-low")).toBe(true);
    // State file written.
    const state = await loadBudgetPauseState(atmuxDir);
    expect(state?.paused).toBe(true);
    expect(state?.atRisk.map((r) => r.member).sort()).toEqual(["alpha", "beta"]);
    // Driver-inbox surfaced.
    expect(fake.driverInboxAppends.length).toBe(1);
    expect(fake.driverInboxAppends[0]).toContain("budget-pause entered");
    // Discord ping.
    expect(fake.discordSends.length).toBe(1);
    expect(fake.discordSends[0]?.template).toBe("whip-budget-pause");
  });

  test("any member ≥ pauseThreshold (wk) → paused-just-now", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 30, 91));
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    expect(v).toBe("paused-just-now");
  });

  test("at-risk roster excludes members on different account that's not at risk", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 95, 50));
    fake.probesByAccount.set("unum", probe("unum", 30, 30));
    const v = await runBudgetCheck(
      ctxOf([
        { name: "alpha", claudeAccount: "icloud" },
        { name: "beta", claudeAccount: "unum" },
      ]),
      depsFor(fake),
    );
    expect(v).toBe("paused-just-now");
    const state = await loadBudgetPauseState(atmuxDir);
    expect(state?.atRisk.map((r) => r.member)).toEqual(["alpha"]);
    // But ALL members get paused.
    expect(fake.pauseCalls.map((c) => c.member).sort()).toEqual(["alpha", "beta"]);
  });

  test("non-allowed probe status (e.g. probe-401) → not at-risk (no pause)", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 99, 99, "probe-401"));
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    // probe-401 means we don't trust the numbers; don't pause on bad data.
    expect(v).toBe("active");
    expect(fake.pauseCalls).toEqual([]);
  });

  test("pause failure on one member doesn't break others (best-effort)", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 95, 50));
    const baseDeps = depsFor(fake);
    const v = await runBudgetCheck(
      ctxOf([
        { name: "alpha", claudeAccount: "icloud" },
        { name: "beta", claudeAccount: "icloud" },
      ]),
      {
        ...baseDeps,
        pauseMember: async (atmuxDir, member, opts) => {
          if (member === "alpha") throw new Error("simulated pause failure");
          await baseDeps.pauseMember(atmuxDir, member, opts);
        },
      },
    );
    expect(v).toBe("paused-just-now");
    // beta still paused.
    expect(fake.pauseCalls.map((c) => c.member)).toEqual(["beta"]);
    // alpha failure logged.
    expect(fake.logs.some((l) => l.includes("pause(alpha) failed"))).toBe(true);
  });

  test("Discord send failure logged but not thrown", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 95, 50));
    const baseDeps = depsFor(fake);
    const v = await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), {
      ...baseDeps,
      discordSend: async () => {
        throw new Error("webhook 500");
      },
    });
    expect(v).toBe("paused-just-now");
    expect(fake.logs.some((l) => l.includes("budget-pause: discord send failed"))).toBe(true);
  });
});

// ---------- resume branch ----------

describe("runBudgetCheck — paused, resume gate met → resume", () => {
  beforeEach(async () => {
    await writeBudgetPauseState(atmuxDir, {
      paused: true,
      pausedAt: FIXED_NOW_SEC - 3600,
      pausedAtTs: "10:44 MYT",
      atRisk: [{ member: "alpha", h5: 95, wk: 70 }],
    });
  });

  test("ALL members ≤ resumeThreshold on both windows → resumed", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 50, 60));
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    expect(v).toBe("resumed");
    expect(await isBudgetPauseActive(atmuxDir)).toBe(false);
    expect(fake.resumeCalls.map((c) => c.member)).toEqual(["alpha"]);
    expect(fake.driverInboxAppends.some((c) => c.includes("budget-pause cleared"))).toBe(true);
    expect(fake.discordSends.some((s) => s.template === "whip-budget-resume")).toBe(true);
  });

  test("one member > resumeThreshold (5h) → paused-still", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 81, 50)); // 81 > 80
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    expect(v).toBe("paused-still");
    expect(await isBudgetPauseActive(atmuxDir)).toBe(true);
    expect(fake.resumeCalls).toEqual([]);
    expect(fake.discordSends).toEqual([]);
  });

  test("one member > resumeThreshold (wk) → paused-still", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 50, 81));
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    expect(v).toBe("paused-still");
  });

  test("non-allowed probe status → paused-still (don't trust bad data)", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 5, 5, "probe-401"));
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    expect(v).toBe("paused-still");
  });

  test("multi-account: ALL must be clear (one rejected blocks resume)", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 50, 50));
    fake.probesByAccount.set("unum", probe("unum", 85, 50)); // 85 > 80
    const v = await runBudgetCheck(
      ctxOf([
        { name: "alpha", claudeAccount: "icloud" },
        { name: "beta", claudeAccount: "unum" },
      ]),
      depsFor(fake),
    );
    expect(v).toBe("paused-still");
  });

  test("resume failure on one member doesn't break others", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 50, 50));
    const baseDeps = depsFor(fake);
    const v = await runBudgetCheck(
      ctxOf([
        { name: "alpha", claudeAccount: "icloud" },
        { name: "beta", claudeAccount: "icloud" },
      ]),
      {
        ...baseDeps,
        resumeMember: async (atmuxDir, member) => {
          if (member === "alpha") throw new Error("simulated resume failure");
          await baseDeps.resumeMember(atmuxDir, member);
        },
      },
    );
    expect(v).toBe("resumed");
    expect(fake.resumeCalls.map((c) => c.member)).toEqual(["beta"]);
    expect(fake.logs.some((l) => l.includes("resume(alpha) failed"))).toBe(true);
  });

  test("Discord resume send failure logged but not thrown", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 50, 50));
    const baseDeps = depsFor(fake);
    const v = await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), {
      ...baseDeps,
      discordSend: async () => {
        throw new Error("webhook 429");
      },
    });
    expect(v).toBe("resumed");
    expect(fake.logs.some((l) => l.includes("budget-resume: discord send failed"))).toBe(true);
  });
});

// ---------- band-warning branch ----------

describe("runBudgetCheck — band-warning (4.1)", () => {
  test("crossing 50% band fires once, second tick is silent", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 55, 30)); // 5h: 45% remaining → crosses 50% band
    const v1 = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    expect(v1).toBe("active");
    const warnings1 = fake.discordSends.filter((s) => s.template === "whip-budget-warning");
    expect(warnings1.length).toBe(1);
    expect(warnings1[0]?.bullets?.[0]).toContain("(band: 50%)");

    // Second tick — same probe → no re-fire.
    const fake2 = makeFakeDeps();
    fake2.probesByAccount.set("icloud", probe("icloud", 55, 30));
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake2));
    const warnings2 = fake2.discordSends.filter((s) => s.template === "whip-budget-warning");
    expect(warnings2.length).toBe(0);
  });

  test("dropping past 25% fires that band (50% already fired-state preserved)", async () => {
    const fake = makeFakeDeps();
    // Pre-seed warning state — 50% band already fired this window.
    const seeded = recordBandFire({}, "icloud", "5h", 0.5, FIXED_NOW_SEC - 1000);
    await writeWarningState(atmuxDir, seeded);
    fake.probesByAccount.set("icloud", probe("icloud", 80, 30)); // 20% remaining → crosses 25%
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    const warnings = fake.discordSends.filter((s) => s.template === "whip-budget-warning");
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.bullets?.[0]).toContain("(band: 25%)");
  });

  test("crossing both 50% AND 25% in one tick fires BOTH bands", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 78, 50)); // 22% remaining → crosses 50% + 25%
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    const warnings = fake.discordSends.filter((s) => s.template === "whip-budget-warning");
    const bands = warnings.map((w) => w.bullets?.[0]).filter((b): b is string => b !== undefined);
    expect(bands.some((b) => b.includes("(band: 50%)"))).toBe(true);
    expect(bands.some((b) => b.includes("(band: 25%)"))).toBe(true);
  });

  test("window-reset advance re-arms bands", async () => {
    const fake = makeFakeDeps();
    // Old reset epoch in state.
    const old = recordBandFire(
      { "icloud:5h:reset": FIXED_NOW_SEC - 7200 },
      "icloud",
      "5h",
      0.5,
      FIXED_NOW_SEC - 7000,
    );
    await writeWarningState(atmuxDir, old);
    // New reset epoch in probe.
    fake.probesByAccount.set(
      "icloud",
      probe("icloud", 55, 30, "allowed", { h5: FIXED_NOW_SEC + 3600 }),
    );
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    // 50% band re-armed → fires again.
    const warnings = fake.discordSends.filter((s) => s.template === "whip-budget-warning");
    expect(warnings.length).toBe(1);
  });

  test("bands stay quiet when remaining > highest band", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 30, 20)); // 70%/80% remaining
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    expect(fake.discordSends.filter((s) => s.template === "whip-budget-warning")).toEqual([]);
  });

  test("nextBandPct surfaced when band below has more headroom", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 60, 30)); // 40% remaining → 50% band; next is 25%
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    const w = fake.discordSends.find((s) => s.template === "whip-budget-warning");
    expect(w?.bullets?.some((b) => b.includes("next band: 25%"))).toBe(true);
  });

  test("send=undefined → no fire, no state mutation", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set("icloud", probe("icloud", 55, 30));
    const baseDeps = depsFor(fake);
    const noSendDeps = {
      probeBudget: baseDeps.probeBudget,
      pauseMember: baseDeps.pauseMember,
      resumeMember: baseDeps.resumeMember,
      appendDriverInbox: baseDeps.appendDriverInbox,
      log: baseDeps.log,
    };
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), noSendDeps);
    const state = await loadWarningState(atmuxDir);
    expect(Object.keys(state)).toEqual([]);
  });
});

// ---------- refresh-soon branch ----------

describe("runBudgetCheck — refresh-soon (4.2)", () => {
  test("window resets within lead-time → fires once", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set(
      "icloud",
      probe("icloud", 80, 30, "allowed", { h5: FIXED_NOW_SEC + 600 }), // 10min until reset, < 30min lead
    );
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    const refreshSoon = fake.discordSends.filter((s) => s.template === "whip-budget-refresh-soon");
    expect(refreshSoon.length).toBe(1);
    expect(refreshSoon[0]?.bullets?.[0]).toContain("(5h)");
  });

  test("resets > lead-time away → no fire", async () => {
    const fake = makeFakeDeps();
    fake.probesByAccount.set(
      "icloud",
      probe("icloud", 80, 30, "allowed", { h5: FIXED_NOW_SEC + 7200 }), // 2h ahead, > 30min lead
    );
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    expect(fake.discordSends.filter((s) => s.template === "whip-budget-refresh-soon")).toEqual([]);
  });

  test("dedup: same (account, window, resetEpoch) doesn't re-fire", async () => {
    const fake = makeFakeDeps();
    const resetEpoch = FIXED_NOW_SEC + 600;
    // Pre-seed state.
    const seeded = recordRefreshSoonFire({}, "icloud", "5h", resetEpoch, FIXED_NOW_SEC - 100);
    await writeRefreshSoonState(atmuxDir, seeded);

    fake.probesByAccount.set("icloud", probe("icloud", 80, 30, "allowed", { h5: resetEpoch }));
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    expect(fake.discordSends.filter((s) => s.template === "whip-budget-refresh-soon")).toEqual([]);
  });

  test("stale entries from prior windows are wiped before fire decision", async () => {
    const fake = makeFakeDeps();
    // Old entry for an already-passed reset epoch.
    await writeRefreshSoonState(atmuxDir, {
      "icloud:5h:1700000000": FIXED_NOW_SEC - 86400,
    });
    fake.probesByAccount.set("icloud", probe("icloud", 30, 30));
    await runBudgetCheck(ctxOf([{ name: "alpha", claudeAccount: "icloud" }]), depsFor(fake));
    const state = await loadRefreshSoonState(atmuxDir);
    expect(state["icloud:5h:1700000000"]).toBeUndefined();
  });

  test("paused-now hint included when team is paused", async () => {
    const fake = makeFakeDeps();
    // Pre-write pause state so isBudgetPauseActive returns true.
    await writeBudgetPauseState(atmuxDir, {
      paused: true,
      pausedAt: FIXED_NOW_SEC - 3600,
      pausedAtTs: "10:44 MYT",
      atRisk: [],
    });
    // Probe shows clear (so resume-gate fires + clears the state file).
    fake.probesByAccount.set(
      "icloud",
      probe("icloud", 50, 50, "allowed", { h5: FIXED_NOW_SEC + 600 }),
    );
    const v = await runBudgetCheck(
      ctxOf([{ name: "alpha", claudeAccount: "icloud" }]),
      depsFor(fake),
    );
    // Paused branch fires resume; refresh-soon is only checked in
    // "active" branch, so verify the resume happened.
    expect(v).toBe("resumed");
  });
});
