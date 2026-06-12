// Unit tests for src/core/account-pool.ts (ADR-199 minimal slice).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BudgetProbeState,
  loadBudgetMap,
  readBudgetProbe,
  readRrCounter,
  recordSpawn,
  rrLastSpawnMap,
  selectAccount,
} from "../../../src/core/account-pool.ts";
import type { ClaudeAccountPoolEntry } from "../../../src/schema/cockpit.ts";

const NOW = 1_779_400_000;
const ALLOWED = "allowed";

function probe(util: number, opts: Partial<BudgetProbeState> = {}): BudgetProbeState {
  return {
    h5_util: util,
    wk_util: 0.5,
    h5_reset: NOW + 3600,
    wk_reset: NOW + 86_400,
    status: opts.status ?? ALLOWED,
    probedAt: opts.probedAt ?? NOW - 60,
  };
}

function entry(label: string, weight?: number): ClaudeAccountPoolEntry {
  return {
    configDir: `/root/.claude-${label}`,
    label,
    ...(weight === undefined ? {} : { weight }),
  };
}

describe("selectAccount", () => {
  test("empty pool → null + reason", () => {
    const r = selectAccount({ pool: [], budgetByLabel: new Map(), now: NOW });
    expect(r.account).toBeNull();
    expect(r.reason).toBe("pool empty");
  });

  test("single entry with allowed budget → selected", () => {
    const r = selectAccount({
      pool: [entry("a")],
      budgetByLabel: new Map([["a", probe(0.1)]]),
      now: NOW,
    });
    expect(r.account?.label).toBe("a");
    expect(r.reason).toContain("10.0%");
  });

  test("picks lowest h5_util", () => {
    const r = selectAccount({
      pool: [entry("a"), entry("b"), entry("c")],
      budgetByLabel: new Map([
        ["a", probe(0.5)],
        ["b", probe(0.1)],
        ["c", probe(0.3)],
      ]),
      now: NOW,
    });
    expect(r.account?.label).toBe("b");
  });

  test("ties broken by weight (higher wins)", () => {
    const r = selectAccount({
      pool: [entry("a", 0.5), entry("b", 1.0), entry("c", 0.8)],
      budgetByLabel: new Map([
        ["a", probe(0.2)],
        ["b", probe(0.2)],
        ["c", probe(0.2)],
      ]),
      now: NOW,
    });
    expect(r.account?.label).toBe("b");
  });

  test("further ties broken by pool-array order", () => {
    const r = selectAccount({
      pool: [entry("alpha"), entry("bravo"), entry("charlie")],
      budgetByLabel: new Map([
        ["alpha", probe(0.5)],
        ["bravo", probe(0.5)],
        ["charlie", probe(0.5)],
      ]),
      now: NOW,
    });
    expect(r.account?.label).toBe("alpha");
  });

  test("round-robin tiebreak: least-recently-spawned wins over array order", () => {
    // All three tie on util AND weight, so without round-robin the
    // first array entry ('alpha') would win. With a counter that says
    // alpha+bravo were spawned recently but charlie longest ago,
    // charlie should win.
    const r = selectAccount({
      pool: [entry("alpha"), entry("bravo"), entry("charlie")],
      budgetByLabel: new Map([
        ["alpha", probe(0.5)],
        ["bravo", probe(0.5)],
        ["charlie", probe(0.5)],
      ]),
      now: NOW,
      lastSpawnByLabel: new Map([
        ["alpha", 9],
        ["bravo", 8],
        ["charlie", 2], // least recently spawned
      ]),
    });
    expect(r.account?.label).toBe("charlie");
  });

  test("round-robin tiebreak: never-spawned (absent) beats any spawned entry", () => {
    // 'bravo' has no counter entry → ordinal -1 → most preferred, even
    // though 'alpha' sits earlier in the array.
    const r = selectAccount({
      pool: [entry("alpha"), entry("bravo")],
      budgetByLabel: new Map([
        ["alpha", probe(0.2)],
        ["bravo", probe(0.2)],
      ]),
      now: NOW,
      lastSpawnByLabel: new Map([["alpha", 5]]),
    });
    expect(r.account?.label).toBe("bravo");
  });

  test("round-robin only fires on full tie — util still dominates", () => {
    // 'alpha' was spawned least recently but has WORSE util; util wins.
    const r = selectAccount({
      pool: [entry("alpha"), entry("bravo")],
      budgetByLabel: new Map([
        ["alpha", probe(0.9)], // worse util
        ["bravo", probe(0.1)], // better util
      ]),
      now: NOW,
      lastSpawnByLabel: new Map([
        ["alpha", 0],
        ["bravo", 99],
      ]),
    });
    expect(r.account?.label).toBe("bravo");
  });

  test("round-robin yields to weight — weight outranks last-spawn", () => {
    // Tie on util; 'alpha' spawned less recently but 'bravo' has higher
    // weight, which outranks the round-robin rung.
    const r = selectAccount({
      pool: [entry("alpha", 0.5), entry("bravo", 1.0)],
      budgetByLabel: new Map([
        ["alpha", probe(0.2)],
        ["bravo", probe(0.2)],
      ]),
      now: NOW,
      lastSpawnByLabel: new Map([
        ["alpha", 0], // least recently spawned
        ["bravo", 99],
      ]),
    });
    expect(r.account?.label).toBe("bravo");
  });

  test("no lastSpawnByLabel supplied → falls through to array order", () => {
    // Without the round-robin map, a full util+weight tie resolves by
    // pool-array order (pre-existing behavior preserved).
    const r = selectAccount({
      pool: [entry("first"), entry("second")],
      budgetByLabel: new Map([
        ["first", probe(0.3)],
        ["second", probe(0.3)],
      ]),
      now: NOW,
    });
    expect(r.account?.label).toBe("first");
  });

  test("throttled entries excluded when ANY entry is healthy", () => {
    const r = selectAccount({
      pool: [entry("a"), entry("b"), entry("c")],
      budgetByLabel: new Map([
        ["a", probe(0.1, { status: "throttled" })], // lowest util but THROTTLED
        ["b", probe(0.5)],
        ["c", probe(0.3)],
      ]),
      now: NOW,
    });
    // 'a' is excluded; lowest among {b, c} is c at 0.3
    expect(r.account?.label).toBe("c");
  });

  test("all throttled → still picks (least-bad) with explicit reason", () => {
    const r = selectAccount({
      pool: [entry("a"), entry("b")],
      budgetByLabel: new Map([
        ["a", probe(0.5, { status: "throttled" })],
        ["b", probe(0.3, { status: "throttled" })],
      ]),
      now: NOW,
    });
    expect(r.account?.label).toBe("b"); // 0.3 < 0.5
    expect(r.reason).toContain("all 2 entries throttled");
  });

  test("stale data sorts AFTER fresh data", () => {
    const r = selectAccount({
      pool: [entry("stale"), entry("fresh")],
      budgetByLabel: new Map([
        ["stale", probe(0.1, { probedAt: NOW - 7200 })], // 2hr old, very stale
        ["fresh", probe(0.5)], // 1min old
      ]),
      now: NOW,
      staleThresholdSec: 1800, // 30min
    });
    // 'fresh' wins despite higher util because data is fresh
    expect(r.account?.label).toBe("fresh");
  });

  test("missing budget data treated as stale (weight + order)", () => {
    const r = selectAccount({
      pool: [entry("missing", 0.5), entry("also-missing", 1.0)],
      budgetByLabel: new Map(), // empty — both missing
      now: NOW,
    });
    // Both stale → weight tiebreak. also-missing has higher weight.
    expect(r.account?.label).toBe("also-missing");
    expect(r.reason).toContain("stale/missing");
  });

  test("explicit null in budget map = missing", () => {
    const r = selectAccount({
      pool: [entry("a")],
      budgetByLabel: new Map([["a", null]]),
      now: NOW,
    });
    expect(r.account?.label).toBe("a");
    expect(r.reason).toContain("stale/missing");
  });

  test("mixed fresh+stale: fresh wins regardless of util", () => {
    const r = selectAccount({
      pool: [entry("fresh-high"), entry("stale-low")],
      budgetByLabel: new Map([
        ["fresh-high", probe(0.9)], // fresh, near limit
        ["stale-low", probe(0.05, { probedAt: NOW - 7200 })], // stale, looks great
      ]),
      now: NOW,
      staleThresholdSec: 1800,
    });
    expect(r.account?.label).toBe("fresh-high");
  });

  test("custom stale threshold honored", () => {
    // With staleThresholdSec=60, anything older than 60s is stale.
    const r = selectAccount({
      pool: [entry("a"), entry("b")],
      budgetByLabel: new Map([
        ["a", probe(0.3, { probedAt: NOW - 30 })], // fresh under 60s
        ["b", probe(0.1, { probedAt: NOW - 120 })], // stale
      ]),
      now: NOW,
      staleThresholdSec: 60,
    });
    expect(r.account?.label).toBe("a");
  });

  test("reason includes percentage with 1 decimal", () => {
    const r = selectAccount({
      pool: [entry("a")],
      budgetByLabel: new Map([["a", probe(0.137)]]),
      now: NOW,
    });
    expect(r.reason).toContain("13.7%");
  });

  test("zero util OK", () => {
    const r = selectAccount({
      pool: [entry("a"), entry("b")],
      budgetByLabel: new Map([
        ["a", probe(0)],
        ["b", probe(0.001)],
      ]),
      now: NOW,
    });
    expect(r.account?.label).toBe("a");
  });
});

// ---------- readBudgetProbe + loadBudgetMap (I/O wrappers) ----------

describe("readBudgetProbe + loadBudgetMap", () => {
  let scratch: string;
  let stateDir: string;

  beforeEach(async () => {
    scratch = join(tmpdir(), `atmux-account-pool-${Date.now()}-${Math.random()}`);
    stateDir = join(scratch, ".atmux", "state");
    await mkdir(stateDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("readBudgetProbe — file absent → null", async () => {
    const r = await readBudgetProbe("missing", scratch);
    expect(r).toBeNull();
  });

  test("readBudgetProbe — valid JSON returns parsed state", async () => {
    await writeFile(
      join(stateDir, "budget-probe-personal.json"),
      JSON.stringify({
        h5_util: 0.42,
        wk_util: 0.55,
        h5_reset: 1779426000,
        wk_reset: 1779890400,
        status: "allowed",
        probedAt: 1779408907,
      }),
    );
    const r = await readBudgetProbe("personal", scratch);
    expect(r?.h5_util).toBe(0.42);
    expect(r?.status).toBe("allowed");
  });

  test("readBudgetProbe — malformed JSON → null", async () => {
    await writeFile(join(stateDir, "budget-probe-broken.json"), "{not json");
    const r = await readBudgetProbe("broken", scratch);
    expect(r).toBeNull();
  });

  test("readBudgetProbe — missing required field → null", async () => {
    // Has the file but no h5_util / probedAt / status.
    await writeFile(
      join(stateDir, "budget-probe-incomplete.json"),
      JSON.stringify({ wk_util: 0.5 }),
    );
    const r = await readBudgetProbe("incomplete", scratch);
    expect(r).toBeNull();
  });

  test("loadBudgetMap — every label gets an entry (null when missing)", async () => {
    await writeFile(
      join(stateDir, "budget-probe-a.json"),
      JSON.stringify({
        h5_util: 0.1,
        wk_util: 0.2,
        h5_reset: 1,
        wk_reset: 2,
        status: "allowed",
        probedAt: 1779408907,
      }),
    );
    // 'b' file deliberately absent — expect null entry
    const pool: ClaudeAccountPoolEntry[] = [
      { configDir: "/root/.claude-a", label: "a" },
      { configDir: "/root/.claude-b", label: "b" },
    ];
    const m = await loadBudgetMap(pool, scratch);
    expect(m.get("a")?.h5_util).toBe(0.1);
    expect(m.get("b")).toBeNull();
    expect(m.size).toBe(2);
  });

  test("loadBudgetMap — empty pool yields empty map", async () => {
    const m = await loadBudgetMap([], scratch);
    expect(m.size).toBe(0);
  });
});

// ---------- round-robin counter persistence (ADR-199 §D2 step 5) ----------

describe("readRrCounter + recordSpawn + rrLastSpawnMap", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = join(tmpdir(), `atmux-rr-${Date.now()}-${Math.random()}`);
    await mkdir(join(scratch, ".atmux", "state"), { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("readRrCounter — absent file → zeroed cold-start state", async () => {
    const s = await readRrCounter(scratch);
    expect(s.counter).toBe(0);
    expect(s.lastSpawnByLabel).toEqual({});
  });

  test("recordSpawn — bumps counter and stamps the label", async () => {
    const s = await recordSpawn("c-u", scratch);
    expect(s.counter).toBe(1);
    expect(s.lastSpawnByLabel["c-u"]).toBe(1);
  });

  test("recordSpawn — persists across reads (durable round-robin)", async () => {
    await recordSpawn("c-u", scratch);
    await recordSpawn("c-ic", scratch);
    const reread = await readRrCounter(scratch);
    expect(reread.counter).toBe(2);
    expect(reread.lastSpawnByLabel["c-u"]).toBe(1);
    expect(reread.lastSpawnByLabel["c-ic"]).toBe(2);
  });

  test("recordSpawn — re-spawning a label restamps it to the latest ordinal", async () => {
    await recordSpawn("c-u", scratch); // c-u → 1
    await recordSpawn("c-ic", scratch); // c-ic → 2
    await recordSpawn("c-u", scratch); // c-u restamped → 3
    const s = await readRrCounter(scratch);
    expect(s.counter).toBe(3);
    expect(s.lastSpawnByLabel["c-u"]).toBe(3);
    expect(s.lastSpawnByLabel["c-ic"]).toBe(2);
  });

  test("rrLastSpawnMap — feeds selectAccount so spawn rotates away from last pick", async () => {
    // Spawn c-u once, then select among {c-u, c-ic} tied on util:
    // c-ic (never spawned, ordinal -1) must win the round-robin rung.
    await recordSpawn("c-u", scratch);
    const state = await readRrCounter(scratch);
    const r = selectAccount({
      pool: [entry("c-u"), entry("c-ic")],
      budgetByLabel: new Map([
        ["c-u", probe(0.3)],
        ["c-ic", probe(0.3)],
      ]),
      now: NOW,
      lastSpawnByLabel: rrLastSpawnMap(state),
    });
    expect(r.account?.label).toBe("c-ic");
  });

  test("readRrCounter — malformed JSON → zeroed state", async () => {
    await writeFile(join(scratch, ".atmux", "state", "pool-rr-counter.json"), "{broken");
    const s = await readRrCounter(scratch);
    expect(s.counter).toBe(0);
    expect(s.lastSpawnByLabel).toEqual({});
  });

  test("readRrCounter — strips non-numeric label ordinals from hand-edited junk", async () => {
    await writeFile(
      join(scratch, ".atmux", "state", "pool-rr-counter.json"),
      JSON.stringify({ counter: 5, lastSpawnByLabel: { good: 3, bad: "nope", inf: null } }),
    );
    const s = await readRrCounter(scratch);
    expect(s.counter).toBe(5);
    expect(s.lastSpawnByLabel).toEqual({ good: 3 });
  });
});
