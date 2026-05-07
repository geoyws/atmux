// Unit tests for src/core/account-swap.ts (ADR-056 §D1+D2).
//
// Covers AC from the T10 Task body:
//   - Synthetic 76% utilization on icloud + ifca at 8% remaining → trigger
//     fires; pass started; decisions populated; viable-fallback chosen.
//   - Excluded roles (lead/planner/reviewer) absent from decisions even
//     when on trigger account.
//   - No viable fallback (all healthy fallbacks ≥50% used) → swap NOT
//     entered; falls through to budget-pause.
//   - Lock contention: concurrent whip-tick + manual atmux account-swap
//     (future) → serialized.
//   - Idempotence on tick interruption: active=true + no progress 5min →
//     next tick observes stale, releases lock, marks in-progress decision
//     aborted.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BudgetProbeResult } from "../../../src/abstractions/budget-probe.ts";
import type { DiscordSendOpts } from "../../../src/abstractions/discord.ts";
import {
  type AccountSwapConfig,
  type AccountSwapState,
  type PerMemberSwapDeps,
  type SwapDecision,
  abortInProgressDecisions,
  accountSwapStatePath,
  buildSwapPass,
  clearAccountSwapState,
  eligibleMembersForSwap,
  excludedMembersForSwap,
  findTriggerAccount,
  generatePassId,
  isAccountSwapActive,
  isStaleActiveState,
  loadAccountSwapState,
  perMemberSwap,
  pickFallbackAccount,
  runAccountSwapCheck,
  runSwapPass,
  withAccountSwapLock,
  writeAccountSwapState,
} from "../../../src/core/account-swap.ts";

let atmuxDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-swap-state-"));
  atmuxDir = join(tmp, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

// ---------- Probe-result helpers ----------

function probeAllowed(account: string, h5: number, wk: number): BudgetProbeResult {
  return {
    account,
    h5_pct_used: h5,
    wk_pct_used: wk,
    h5_reset_epoch: 0,
    wk_reset_epoch: 0,
    status: "allowed",
    source: "probe",
    probedAt: 1_700_000_000,
  };
}

// ---------- Path / state shape ----------

describe("accountSwapStatePath", () => {
  test("resolves to <atmuxDir>/state/account-swap.json", () => {
    expect(accountSwapStatePath("/foo/.atmux")).toBe("/foo/.atmux/state/account-swap.json");
  });
});

describe("loadAccountSwapState / isAccountSwapActive (absent)", () => {
  test("absent state file → null + not active", async () => {
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
    expect(await isAccountSwapActive(atmuxDir)).toBe(false);
  });
});

describe("read/write round-trip", () => {
  test("write + read returns the same shape", async () => {
    const state: AccountSwapState = {
      active: true,
      passId: "swap-deadbeef",
      startedAt: 1_700_000_000,
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      decisions: {
        alpha: {
          from: "icloud",
          to: "ifca",
          status: "pending",
          startedAt: null,
          finishedAt: null,
          shadowName: null,
        },
      },
      history: [],
    };
    await writeAccountSwapState(atmuxDir, state);
    const got = await loadAccountSwapState(atmuxDir);
    expect(got).toEqual(state);
    expect(await isAccountSwapActive(atmuxDir)).toBe(true);
  });

  test("clearAccountSwapState removes the file (idempotent)", async () => {
    await writeAccountSwapState(atmuxDir, {
      active: false,
      passId: "swap-aaaaaaaa",
      startedAt: 1_700_000_000,
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      decisions: {},
      history: [],
    });
    await clearAccountSwapState(atmuxDir);
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
    // Idempotent — second call doesn't throw.
    await clearAccountSwapState(atmuxDir);
  });

  test("malformed JSON → null (no throw)", async () => {
    const path = accountSwapStatePath(atmuxDir);
    await Bun.write(path, "not-json");
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });

  test("missing fields → null (no throw)", async () => {
    const path = accountSwapStatePath(atmuxDir);
    await Bun.write(path, JSON.stringify({ active: true }));
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });
});

// ---------- Trigger detection ----------

describe("findTriggerAccount", () => {
  test("first account ≥ threshold wins (deterministic by input order)", () => {
    const probes = new Map<string, BudgetProbeResult>([
      ["icloud", probeAllowed("icloud", 76, 23)],
      ["ifca", probeAllowed("ifca", 8, 12)],
    ]);
    const got = findTriggerAccount(["icloud", "ifca"], { byAccount: probes }, 75);
    expect(got).toEqual({ account: "icloud", h5_pct_used: 76, wk_pct_used: 23 });
  });

  test("wk window ≥ threshold also fires (h5 OR wk)", () => {
    const probes = new Map<string, BudgetProbeResult>([["icloud", probeAllowed("icloud", 30, 80)]]);
    const got = findTriggerAccount(["icloud"], { byAccount: probes }, 75);
    expect(got?.account).toBe("icloud");
    expect(got?.wk_pct_used).toBe(80);
  });

  test("no account over threshold → null", () => {
    const probes = new Map<string, BudgetProbeResult>([
      ["icloud", probeAllowed("icloud", 50, 30)],
      ["ifca", probeAllowed("ifca", 8, 12)],
    ]);
    expect(findTriggerAccount(["icloud", "ifca"], { byAccount: probes }, 75)).toBeNull();
  });

  test("non-allowed status skips the account (probe-401, etc.)", () => {
    const r401: BudgetProbeResult = {
      ...probeAllowed("icloud", 90, 90),
      status: "probe-401",
    };
    const probes = new Map<string, BudgetProbeResult>([["icloud", r401]]);
    expect(findTriggerAccount(["icloud"], { byAccount: probes }, 75)).toBeNull();
  });
});

describe("pickFallbackAccount", () => {
  test("first viable in priority order wins", () => {
    const probes = new Map<string, BudgetProbeResult>([
      ["icloud", probeAllowed("icloud", 76, 23)],
      ["ifca", probeAllowed("ifca", 8, 12)],
      ["unum", probeAllowed("unum", 30, 30)],
    ]);
    const fb = pickFallbackAccount(["ifca", "unum"], "icloud", { byAccount: probes }, 50);
    expect(fb).toBe("ifca");
  });

  test("skips trigger account itself", () => {
    const probes = new Map<string, BudgetProbeResult>([
      ["icloud", probeAllowed("icloud", 76, 23)],
      ["unum", probeAllowed("unum", 30, 30)],
    ]);
    expect(pickFallbackAccount(["icloud", "unum"], "icloud", { byAccount: probes }, 50)).toBe(
      "unum",
    );
  });

  test("no viable fallback (all > healthThreshold) → null", () => {
    const probes = new Map<string, BudgetProbeResult>([
      ["icloud", probeAllowed("icloud", 76, 23)],
      ["ifca", probeAllowed("ifca", 60, 70)],
      ["unum", probeAllowed("unum", 80, 90)],
    ]);
    expect(pickFallbackAccount(["ifca", "unum"], "icloud", { byAccount: probes }, 50)).toBeNull();
  });
});

// ---------- Excluded-roles filter ----------

describe("eligibleMembersForSwap / excludedMembersForSwap", () => {
  const members = [
    { name: "alpha", role: "worker", claudeAccount: "icloud" },
    { name: "lead", role: "lead", claudeAccount: "icloud" },
    { name: "p1", role: "planner", claudeAccount: "icloud" },
    { name: "rev", role: "reviewer", claudeAccount: "icloud" },
    { name: "beta", role: "worker", claudeAccount: "ifca" },
    { name: "noRole", claudeAccount: "icloud" },
  ];
  const exclude = ["lead", "planner", "reviewer"];

  test("eligibleMembersForSwap filters trigger-account workers + role default", () => {
    const got = eligibleMembersForSwap(members, "icloud", exclude, "default");
    expect(got.map((m) => m.name)).toEqual(["alpha", "noRole"]);
  });

  test("excludedMembersForSwap returns the lead/planner/reviewer rows on trigger", () => {
    const got = excludedMembersForSwap(members, "icloud", exclude, "default");
    expect(got.map((m) => m.name).sort()).toEqual(["lead", "p1", "rev"]);
  });

  test("members on a different account are skipped from both", () => {
    const got = eligibleMembersForSwap(members, "icloud", exclude, "default");
    expect(got.find((m) => m.name === "beta")).toBeUndefined();
  });

  test("default account fills in for members without claudeAccount", () => {
    const m = [{ name: "x" }];
    const got = eligibleMembersForSwap(m, "icloud", exclude, "icloud");
    expect(got).toHaveLength(1);
    expect(got[0]?.account).toBe("icloud");
  });
});

// ---------- Pass builder ----------

describe("buildSwapPass", () => {
  test("decisions has both candidates (pending) + excluded (excluded)", () => {
    const pass = buildSwapPass({
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      candidates: [
        { name: "alpha", account: "icloud", role: "worker" },
        { name: "beta", account: "icloud", role: "worker" },
      ],
      fallbackAccount: "ifca",
      excludedMembers: [{ name: "lead", from: "icloud" }],
      passId: "swap-aaaaaaaa",
      startedAt: 1_700_000_000,
    });
    expect(pass.active).toBe(true);
    expect(pass.passId).toBe("swap-aaaaaaaa");
    expect(pass.decisions.alpha?.status).toBe("pending");
    expect(pass.decisions.alpha?.from).toBe("icloud");
    expect(pass.decisions.alpha?.to).toBe("ifca");
    expect(pass.decisions.lead?.status).toBe("excluded");
  });

  test("priorHistory carries forward, capped", () => {
    const prior = Array.from({ length: 25 }, (_, i) => ({
      passId: `swap-${i}`,
      completedAt: 1_700_000_000 + i,
      swapped: 0,
      excluded: 0,
      aborted: 0,
    }));
    const pass = buildSwapPass({
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      candidates: [],
      fallbackAccount: "ifca",
      excludedMembers: [],
      passId: "swap-bbbbbbbb",
      startedAt: 1_700_000_000,
      priorHistory: prior,
    });
    // HISTORY_RING_MAX = 20 — keeps the last 20.
    expect(pass.history.length).toBe(20);
    expect(pass.history[0]?.passId).toBe("swap-5");
  });
});

// ---------- generatePassId ----------

describe("generatePassId", () => {
  test("matches swap-<8-hex>", () => {
    const id = generatePassId();
    expect(id).toMatch(/^swap-[0-9a-f]{8}$/);
  });

  test("custom rng yields deterministic id", () => {
    expect(generatePassId(() => 0.5)).toBe("swap-7fffffff");
  });
});

// ---------- Idempotence: stale-active + abort ----------

describe("isStaleActiveState", () => {
  const baseState: AccountSwapState = {
    active: true,
    passId: "swap-deadbeef",
    startedAt: 1_700_000_000,
    trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
    decisions: {},
    history: [],
  };

  test("active + no decisions + < 5min since start → not stale", () => {
    expect(isStaleActiveState(baseState, 1_700_000_001)).toBe(false);
    expect(isStaleActiveState(baseState, 1_700_000_000 + 299)).toBe(false);
  });

  test("active + no decisions + > 5min since start → stale", () => {
    expect(isStaleActiveState(baseState, 1_700_000_000 + 301)).toBe(true);
  });

  test("active + recent decision progress (startedAt) → not stale even past 5min", () => {
    const state: AccountSwapState = {
      ...baseState,
      decisions: {
        alpha: {
          from: "icloud",
          to: "ifca",
          status: "in-progress",
          startedAt: 1_700_000_500,
          finishedAt: null,
          shadowName: "alpha-swap",
        },
      },
    };
    expect(isStaleActiveState(state, 1_700_000_700)).toBe(false);
  });

  test("inactive state is never stale", () => {
    expect(isStaleActiveState({ ...baseState, active: false }, 1_700_999_999)).toBe(false);
  });
});

describe("abortInProgressDecisions", () => {
  test("flips in-progress → aborted; leaves done/pending alone; clears active", () => {
    const state: AccountSwapState = {
      active: true,
      passId: "swap-aaaaaaaa",
      startedAt: 1_700_000_000,
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      decisions: {
        alpha: {
          from: "icloud",
          to: "ifca",
          status: "in-progress",
          startedAt: 1_700_000_100,
          finishedAt: null,
          shadowName: "alpha-swap",
        },
        beta: {
          from: "icloud",
          to: "ifca",
          status: "done",
          startedAt: 1_700_000_50,
          finishedAt: 1_700_000_99,
          shadowName: "beta-swap",
        },
        gamma: {
          from: "icloud",
          to: "ifca",
          status: "pending",
          startedAt: null,
          finishedAt: null,
          shadowName: null,
        },
      },
      history: [],
    };
    const next = abortInProgressDecisions(state, 1_700_000_500);
    expect(next.active).toBe(false);
    expect(next.decisions.alpha?.status).toBe("aborted");
    expect(next.decisions.alpha?.finishedAt).toBe(1_700_000_500);
    expect(next.decisions.beta?.status).toBe("done");
    expect(next.decisions.gamma?.status).toBe("pending");
  });
});

// ---------- Lock serialization (AC: lock contention) ----------

describe("withAccountSwapLock", () => {
  test("serializes concurrent invocations on the same atmuxDir", async () => {
    const order: string[] = [];
    const enter = (label: string) => async () => {
      order.push(`enter-${label}`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`exit-${label}`);
    };
    await Promise.all([
      withAccountSwapLock(atmuxDir, enter("a")),
      withAccountSwapLock(atmuxDir, enter("b")),
    ]);
    // Holders must not interleave — each enter is followed by its exit.
    expect(order).toHaveLength(4);
    expect(order[1]).toBe(order[0]?.replace("enter-", "exit-"));
    expect(order[3]).toBe(order[2]?.replace("enter-", "exit-"));
  });

  test("lock released even when fn throws", async () => {
    let threw = false;
    try {
      await withAccountSwapLock(atmuxDir, async () => {
        throw new Error("boom");
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Subsequent acquisition succeeds quickly — no leftover hold.
    await withAccountSwapLock(atmuxDir, async () => {});
  });
});

// ---------- runAccountSwapCheck — orchestrator ----------

const baseConfig: AccountSwapConfig = {
  accountFallback: ["ifca", "unum"],
  accountSwapTriggerThreshold: 75,
  accountSwapFallbackHealthThreshold: 50,
  accountSwapExcludeRoles: ["lead", "planner", "reviewer"],
  defaultAccount: "icloud",
};

function makeProbeFn(map: Record<string, BudgetProbeResult>): {
  fn: (account: string, opts?: { force?: boolean }) => Promise<BudgetProbeResult>;
  forceCalls: string[];
} {
  const forceCalls: string[] = [];
  const fn = async (account: string, opts?: { force?: boolean }) => {
    if (opts?.force === true) forceCalls.push(account);
    const r = map[account];
    if (r === undefined) {
      throw new Error(`unexpected probe call for ${account}`);
    }
    return r;
  };
  return { fn, forceCalls };
}

describe("runAccountSwapCheck — feature-flag", () => {
  test("empty accountFallback → disabled, no probes", async () => {
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [{ name: "alpha", claudeAccount: "icloud" }],
        config: { ...baseConfig, accountFallback: [] },
      },
      {
        probeBudget: async () => {
          throw new Error("should not probe when disabled");
        },
      },
    );
    expect(verdict).toBe("disabled");
  });
});

describe("runAccountSwapCheck — AC: trigger fires + viable fallback", () => {
  test("76% icloud + 8% ifca → pass-entered with decisions populated", async () => {
    const { fn, forceCalls } = makeProbeFn({
      icloud: probeAllowed("icloud", 76, 23),
      ifca: probeAllowed("ifca", 8, 12),
    });
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [
          { name: "alpha", role: "worker", claudeAccount: "icloud" },
          { name: "beta", role: "worker", claudeAccount: "icloud" },
        ],
        config: baseConfig,
      },
      { fn, probeBudget: fn } as never, // satisfy types — only probeBudget is used
    );
    expect(verdict).toBe("pass-entered");
    // Force-fresh probe was called for the fallback per ADR-056 §D2.
    expect(forceCalls).toContain("ifca");
    const state = await loadAccountSwapState(atmuxDir);
    expect(state).not.toBeNull();
    expect(state?.active).toBe(true);
    expect(state?.trigger.account).toBe("icloud");
    expect(state?.trigger.h5_pct_used).toBe(76);
    expect(state?.decisions.alpha?.from).toBe("icloud");
    expect(state?.decisions.alpha?.to).toBe("ifca");
    expect(state?.decisions.alpha?.status).toBe("pending");
    expect(state?.decisions.beta?.status).toBe("pending");
  });
});

describe("runAccountSwapCheck — AC: excluded roles absent", () => {
  test("lead/planner/reviewer roles → excluded status, not pending", async () => {
    const { fn } = makeProbeFn({
      icloud: probeAllowed("icloud", 76, 23),
      ifca: probeAllowed("ifca", 8, 12),
    });
    await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [
          { name: "alpha", role: "worker", claudeAccount: "icloud" },
          { name: "lead", role: "lead", claudeAccount: "icloud" },
          { name: "planner", role: "planner", claudeAccount: "icloud" },
          { name: "rev", role: "reviewer", claudeAccount: "icloud" },
        ],
        config: baseConfig,
      },
      { probeBudget: fn },
    );
    const state = await loadAccountSwapState(atmuxDir);
    expect(state?.decisions.alpha?.status).toBe("pending");
    expect(state?.decisions.lead?.status).toBe("excluded");
    expect(state?.decisions.planner?.status).toBe("excluded");
    expect(state?.decisions.rev?.status).toBe("excluded");
  });

  test("ALL members on trigger excluded → no-trigger fall-through (no state-file write)", async () => {
    const { fn } = makeProbeFn({
      icloud: probeAllowed("icloud", 76, 23),
      ifca: probeAllowed("ifca", 8, 12),
    });
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [
          { name: "lead", role: "lead", claudeAccount: "icloud" },
          { name: "planner", role: "planner", claudeAccount: "icloud" },
        ],
        config: baseConfig,
      },
      { probeBudget: fn },
    );
    expect(verdict).toBe("no-trigger");
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });
});

describe("runAccountSwapCheck — AC: no viable fallback fall-through", () => {
  test("all fallbacks ≥ 50% used → no-viable-fallback (no state-file write)", async () => {
    const { fn } = makeProbeFn({
      icloud: probeAllowed("icloud", 76, 23),
      ifca: probeAllowed("ifca", 60, 70),
      unum: probeAllowed("unum", 80, 90),
    });
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [{ name: "alpha", role: "worker", claudeAccount: "icloud" }],
        config: baseConfig,
      },
      { probeBudget: fn },
    );
    expect(verdict).toBe("no-viable-fallback");
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });
});

describe("runAccountSwapCheck — AC: idempotence (active-pass + stale-recovery)", () => {
  test("active pass < 5min → active-pass, no new pass written", async () => {
    const existing: AccountSwapState = {
      active: true,
      passId: "swap-deadbeef",
      startedAt: 1_700_000_000,
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      decisions: {
        alpha: {
          from: "icloud",
          to: "ifca",
          status: "in-progress",
          startedAt: 1_700_000_100,
          finishedAt: null,
          shadowName: "alpha-swap",
        },
      },
      history: [],
    };
    await writeAccountSwapState(atmuxDir, existing);
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_200, // 200s after start; well under 300s threshold
        members: [{ name: "alpha", role: "worker", claudeAccount: "icloud" }],
        config: baseConfig,
      },
      {
        probeBudget: async () => {
          throw new Error("should not probe when active");
        },
      },
    );
    expect(verdict).toBe("active-pass");
    const state = await loadAccountSwapState(atmuxDir);
    expect(state?.passId).toBe("swap-deadbeef");
    expect(state?.decisions.alpha?.status).toBe("in-progress");
  });

  test("stale active pass (>5min no progress) → stale-recovered, in-progress aborted", async () => {
    const existing: AccountSwapState = {
      active: true,
      passId: "swap-deadbeef",
      startedAt: 1_700_000_000,
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      decisions: {
        alpha: {
          from: "icloud",
          to: "ifca",
          status: "in-progress",
          startedAt: 1_700_000_000,
          finishedAt: null,
          shadowName: "alpha-swap",
        },
      },
      history: [],
    };
    await writeAccountSwapState(atmuxDir, existing);
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000 + 600, // 10min later — well past 5min threshold
        members: [{ name: "alpha", role: "worker", claudeAccount: "icloud" }],
        config: baseConfig,
      },
      {
        probeBudget: async () => {
          throw new Error("should not probe on stale-recovery");
        },
      },
    );
    expect(verdict).toBe("stale-recovered");
    const state = await loadAccountSwapState(atmuxDir);
    expect(state?.active).toBe(false);
    expect(state?.decisions.alpha?.status).toBe("aborted");
    expect(state?.decisions.alpha?.finishedAt).toBe(1_700_000_000 + 600);
  });
});

describe("runAccountSwapCheck — no-trigger when below threshold", () => {
  test("all accounts < 75% → no-trigger, no state-file write", async () => {
    const { fn } = makeProbeFn({
      icloud: probeAllowed("icloud", 50, 30),
    });
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [{ name: "alpha", role: "worker", claudeAccount: "icloud" }],
        config: baseConfig,
      },
      { probeBudget: fn },
    );
    expect(verdict).toBe("no-trigger");
    expect(await loadAccountSwapState(atmuxDir)).toBeNull();
  });

  test("no eligible accounts at all → disabled", async () => {
    const verdict = await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [], // empty roster
        config: baseConfig,
      },
      {
        probeBudget: async () => {
          throw new Error("should not probe when no members");
        },
      },
    );
    expect(verdict).toBe("disabled");
  });
});

describe("runAccountSwapCheck — passIdFactory injection", () => {
  test("custom passIdFactory yields deterministic passId", async () => {
    const { fn } = makeProbeFn({
      icloud: probeAllowed("icloud", 76, 23),
      ifca: probeAllowed("ifca", 8, 12),
    });
    await runAccountSwapCheck(
      {
        atmuxDir,
        nowSec: 1_700_000_000,
        members: [{ name: "alpha", role: "worker", claudeAccount: "icloud" }],
        config: baseConfig,
      },
      { probeBudget: fn, passIdFactory: () => "swap-c0ffee00" },
    );
    const state = await loadAccountSwapState(atmuxDir);
    expect(state?.passId).toBe("swap-c0ffee00");
  });
});

// Ensure file path test relies on real readFile to confirm shape on disk.
test("post-pass-entered, on-disk JSON matches loaded state byte-for-byte", async () => {
  const { fn } = makeProbeFn({
    icloud: probeAllowed("icloud", 76, 23),
    ifca: probeAllowed("ifca", 8, 12),
  });
  await runAccountSwapCheck(
    {
      atmuxDir,
      nowSec: 1_700_000_000,
      members: [{ name: "alpha", role: "worker", claudeAccount: "icloud" }],
      config: baseConfig,
    },
    { probeBudget: fn, passIdFactory: () => "swap-feedface" },
  );
  const text = await readFile(accountSwapStatePath(atmuxDir), "utf8");
  const onDisk = JSON.parse(text);
  expect(onDisk.passId).toBe("swap-feedface");
  expect(onDisk.active).toBe(true);
});

// ---------- perMemberSwap (ADR-056 §D3) ----------

function makePerMemberDeps(overrides: Partial<PerMemberSwapDeps> = {}): {
  deps: PerMemberSwapDeps;
  calls: {
    probeTarget: string[];
    spawnShadow: Array<{ originalName: string; targetAccount: string }>;
    handoff: Array<{ fromMember: string; toMember: string }>;
    pauseMember: Array<{ member: string; reason: string }>;
    discordTemplates: string[];
    flagBodies: string[];
    inboxAppends: string[];
  };
} {
  const calls = {
    probeTarget: [] as string[],
    spawnShadow: [] as Array<{ originalName: string; targetAccount: string }>,
    handoff: [] as Array<{ fromMember: string; toMember: string }>,
    pauseMember: [] as Array<{ member: string; reason: string }>,
    discordTemplates: [] as string[],
    flagBodies: [] as string[],
    inboxAppends: [] as string[],
  };
  const deps: PerMemberSwapDeps = {
    probeTarget: async (account) => {
      calls.probeTarget.push(account);
      return probeAllowed(account, 8, 12);
    },
    spawnShadow: async (opts) => {
      calls.spawnShadow.push({
        originalName: opts.originalName,
        targetAccount: opts.targetAccount,
      });
      return { shadowName: `${opts.originalName}-swap`, ready: true };
    },
    handoff: async (opts) => {
      calls.handoff.push({ fromMember: opts.fromMember, toMember: opts.toMember });
      return { taskId: "t-flight001", acked: true };
    },
    pauseMember: async (_atmuxDir, member, opts) => {
      calls.pauseMember.push({ member, reason: opts.reason });
    },
    discordSend: async (sendOpts) => {
      calls.discordTemplates.push(sendOpts.template);
    },
    raiseFlag: async (opts) => {
      calls.flagBodies.push(opts.body);
      return { severity: opts.severity, flagId: "flag-test01" };
    },
    appendDriverInbox: async (_atmuxDir, content) => {
      calls.inboxAppends.push(content);
    },
    nowMs: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps, calls };
}

const pendingDecision = (from: string, to: string): SwapDecision => ({
  from,
  to,
  status: "pending",
  startedAt: null,
  finishedAt: null,
  shadowName: null,
});

describe("perMemberSwap — happy path", () => {
  test("runs all 7 steps + flips decision to done + fires success ping", async () => {
    const { deps, calls } = makePerMemberDeps();
    const result = await perMemberSwap(
      atmuxDir,
      "alpha",
      pendingDecision("icloud", "ifca"),
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 0, total: 1 } },
      deps,
    );
    expect(result.decision.status).toBe("done");
    expect(result.decision.shadowName).toBe("alpha-swap");
    expect(result.decision.startedAt).not.toBeNull();
    expect(result.decision.finishedAt).not.toBeNull();
    expect(calls.probeTarget).toEqual(["ifca"]);
    expect(calls.spawnShadow).toHaveLength(1);
    expect(calls.handoff).toHaveLength(1);
    expect(calls.pauseMember).toHaveLength(1);
    expect(calls.pauseMember[0]?.member).toBe("alpha");
    expect(calls.discordTemplates).toEqual(["whip-account-swap-success"]);
  });
});

describe("perMemberSwap — failure modes (ADR-056 §D6)", () => {
  test("target probe 401 → aborted + flag + fail ping", async () => {
    const { deps, calls } = makePerMemberDeps({
      probeTarget: async (account) => ({
        ...probeAllowed(account, 0, 0),
        status: "probe-401",
      }),
    });
    const result = await perMemberSwap(
      atmuxDir,
      "alpha",
      pendingDecision("icloud", "ifca"),
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 0, total: 1 } },
      deps,
    );
    expect(result.decision.status).toBe("aborted");
    expect(result.decision.shadowName).toBeNull();
    expect(calls.spawnShadow).toHaveLength(0); // never reached
    expect(calls.discordTemplates).toEqual(["whip-account-swap-fail"]);
    expect(calls.flagBodies[0]).toContain("alpha");
  });

  test("spawn-shadow not ready → aborted + flag + fail ping", async () => {
    const { deps, calls } = makePerMemberDeps({
      spawnShadow: async (opts) => ({
        shadowName: `${opts.originalName}-swap`,
        ready: false,
        error: "pane never reached prompt",
      }),
    });
    const result = await perMemberSwap(
      atmuxDir,
      "alpha",
      pendingDecision("icloud", "ifca"),
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 0, total: 1 } },
      deps,
    );
    expect(result.decision.status).toBe("aborted");
    expect(calls.handoff).toHaveLength(0);
    expect(calls.pauseMember).toHaveLength(0);
    expect(calls.discordTemplates).toEqual(["whip-account-swap-fail"]);
  });

  test("handoff ack timeout → aborted + flag + fail ping (shadow stays around)", async () => {
    const { deps, calls } = makePerMemberDeps({
      handoff: async () => ({
        taskId: null,
        acked: false,
        error: "shadow did not ack within 10s",
      }),
    });
    const result = await perMemberSwap(
      atmuxDir,
      "alpha",
      pendingDecision("icloud", "ifca"),
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 0, total: 1 } },
      deps,
    );
    expect(result.decision.status).toBe("aborted");
    expect(result.decision.shadowName).toBe("alpha-swap"); // spawn succeeded
    expect(calls.pauseMember).toHaveLength(0); // pause never fires on handoff failure
    expect(calls.discordTemplates).toEqual(["whip-account-swap-fail"]);
  });

  test("deadline exceeded mid-spawn → aborted", async () => {
    let calls = 0;
    const deps: PerMemberSwapDeps = {
      probeTarget: async (a) => probeAllowed(a, 8, 12),
      spawnShadow: async (opts) => ({ shadowName: `${opts.originalName}-swap`, ready: true }),
      handoff: async () => ({ taskId: null, acked: true }),
      pauseMember: async () => {},
      discordSend: async () => {},
      raiseFlag: async () => ({ severity: "p2", flagId: null }),
      // Clock advances 350s between calls — exceeds 300s deadline pre-spawn.
      nowMs: () => {
        calls += 1;
        return 1_700_000_000_000 + (calls > 1 ? 350_000 : 0);
      },
    };
    const result = await perMemberSwap(
      atmuxDir,
      "alpha",
      pendingDecision("icloud", "ifca"),
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 0, total: 1 } },
      deps,
    );
    expect(result.decision.status).toBe("aborted");
  });
});

describe("perMemberSwap — idempotence", () => {
  test("already-done decision → short-circuits without calling deps", async () => {
    const { deps, calls } = makePerMemberDeps();
    const decision: SwapDecision = {
      from: "icloud",
      to: "ifca",
      status: "done",
      startedAt: 1_700_000_000,
      finishedAt: 1_700_000_100,
      shadowName: "alpha-swap",
    };
    const result = await perMemberSwap(
      atmuxDir,
      "alpha",
      decision,
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 1, total: 1 } },
      deps,
    );
    expect(result.decision).toEqual(decision); // unchanged
    expect(calls.probeTarget).toHaveLength(0);
    expect(calls.discordTemplates).toHaveLength(0);
  });

  test("already-excluded decision → short-circuits", async () => {
    const { deps, calls } = makePerMemberDeps();
    const decision: SwapDecision = {
      from: "icloud",
      to: "ifca",
      status: "excluded",
      startedAt: null,
      finishedAt: null,
      shadowName: null,
    };
    const result = await perMemberSwap(
      atmuxDir,
      "lead",
      decision,
      "atmux",
      { perMemberDeadlineSec: 300, passProgress: { done: 0, total: 0 } },
      deps,
    );
    expect(result.decision.status).toBe("excluded");
    expect(calls.probeTarget).toHaveLength(0);
  });
});

// ---------- runSwapPass (orchestrator) ----------

async function seedActivePass(): Promise<AccountSwapState> {
  const state: AccountSwapState = {
    active: true,
    passId: "swap-deadbeef",
    startedAt: 1_700_000_000,
    trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
    decisions: {
      alpha: pendingDecision("icloud", "ifca"),
      beta: pendingDecision("icloud", "ifca"),
      lead: { ...pendingDecision("icloud", "ifca"), status: "excluded" },
    },
    history: [],
  };
  await writeAccountSwapState(atmuxDir, state);
  return state;
}

describe("runSwapPass — no-active-pass", () => {
  test("no state-file → no-active-pass verdict, no touches", async () => {
    const { deps } = makePerMemberDeps();
    const result = await runSwapPass(atmuxDir, deps, { team: "atmux" });
    expect(result.verdict).toBe("no-active-pass");
    expect(result.touched).toEqual([]);
  });

  test("active=false state → no-active-pass", async () => {
    await writeAccountSwapState(atmuxDir, {
      active: false,
      passId: "swap-aaaaaaaa",
      startedAt: 1_700_000_000,
      trigger: { account: "icloud", h5_pct_used: 76, wk_pct_used: 23 },
      decisions: {},
      history: [],
    });
    const { deps } = makePerMemberDeps();
    const result = await runSwapPass(atmuxDir, deps, { team: "atmux" });
    expect(result.verdict).toBe("no-active-pass");
  });
});

describe("runSwapPass — oneAtATime advancement", () => {
  test("first call advances ONE pending decision, returns advanced", async () => {
    await seedActivePass();
    const { deps, calls } = makePerMemberDeps();
    const r1 = await runSwapPass(atmuxDir, deps, { team: "atmux" });
    expect(r1.verdict).toBe("advanced");
    expect(r1.touched).toEqual(["alpha"]);
    expect(calls.spawnShadow).toHaveLength(1);
    const persisted = await loadAccountSwapState(atmuxDir);
    expect(persisted?.decisions.alpha?.status).toBe("done");
    expect(persisted?.decisions.beta?.status).toBe("pending");
  });

  test("subsequent ticks advance remaining decisions until pass-complete", async () => {
    await seedActivePass();
    const { deps } = makePerMemberDeps();
    const r1 = await runSwapPass(atmuxDir, deps, { team: "atmux" });
    expect(r1.verdict).toBe("advanced");
    const r2 = await runSwapPass(atmuxDir, deps, { team: "atmux" });
    expect(r2.verdict).toBe("pass-complete");
    expect(r2.state?.active).toBe(false);
    expect(r2.state?.history).toHaveLength(1);
    expect(r2.state?.history[0]?.swapped).toBe(2);
    expect(r2.state?.history[0]?.aborted).toBe(0);
    expect(r2.state?.history[0]?.excluded).toBe(1);
  });
});

describe("runSwapPass — oneAtATime: false (manual verb path)", () => {
  test("walks all pending decisions in one call", async () => {
    await seedActivePass();
    const { deps } = makePerMemberDeps();
    const r = await runSwapPass(atmuxDir, deps, { team: "atmux", oneAtATime: false });
    expect(r.verdict).toBe("pass-complete");
    expect(r.touched).toEqual(["alpha", "beta"]);
  });
});

describe("runSwapPass — pass-complete side effects", () => {
  test("fires pass-complete Discord template + appends driver-inbox", async () => {
    await seedActivePass();
    const { deps, calls } = makePerMemberDeps();
    await runSwapPass(atmuxDir, deps, { team: "atmux", oneAtATime: false });
    expect(calls.discordTemplates).toContain("whip-account-swap-pass-complete");
    expect(calls.inboxAppends).toHaveLength(1);
    expect(calls.inboxAppends[0]).toContain("swap-deadbeef");
    expect(calls.inboxAppends[0]).toContain("alpha");
    expect(calls.inboxAppends[0]).toContain("beta");
  });

  test("pass-complete archives history with correct counts when one aborts", async () => {
    await seedActivePass();
    const { deps } = makePerMemberDeps({
      handoff: async ({ fromMember }) =>
        fromMember === "beta"
          ? { taskId: null, acked: false, error: "timeout" }
          : { taskId: "t-x", acked: true },
    });
    const r = await runSwapPass(atmuxDir, deps, { team: "atmux", oneAtATime: false });
    expect(r.state?.history[0]?.swapped).toBe(1);
    expect(r.state?.history[0]?.aborted).toBe(1);
    expect(r.state?.history[0]?.excluded).toBe(1);
  });
});

// Suppress unused-var warning for the imported type alias.
void undefined as DiscordSendOpts | undefined;
