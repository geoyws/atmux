// Unit tests for src/core/improve.ts (ADR-052 T1 helpers).
//
// Covers: budget-spec parser, BudgetProbe schema + reader, resolveBudget
// (raw / pct-5h / pct-wk / no-probe), generateRunId, resolveBudgetSpec
// precedence cascade, budgetProbePath helper.
//
// State-file IO + idempotence-detector primitives live in src/core/
// eternal-improvement.ts (T2 territory) — covered by the sibling test
// file `eternal-improvement.test.ts`. T4 owns both files' coverage.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetProbe,
  budgetProbePath,
  DEFAULT_5H_CAP_TOKENS,
  DEFAULT_BUDGET_SPEC,
  DEFAULT_WK_CAP_TOKENS,
  generateRunId,
  HISTORY_RING_MAX,
  parseBudgetSpec,
  readBudgetProbe,
  resolveBudget,
  resolveBudgetSpec,
} from "../../../src/core/improve.ts";
import { SchemaError } from "../../../src/errors.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-improve-core-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Constants ----------

describe("constants", () => {
  test("DEFAULT_BUDGET_SPEC matches ADR-052 §Budget formula", () => {
    expect(DEFAULT_BUDGET_SPEC).toBe("30%-wk");
  });

  test("HISTORY_RING_MAX matches ADR-052 §State-file-schema cap", () => {
    expect(HISTORY_RING_MAX).toBe(50);
  });

  test("DEFAULT_5H_CAP_TOKENS / DEFAULT_WK_CAP_TOKENS are positive integers", () => {
    expect(DEFAULT_5H_CAP_TOKENS).toBeGreaterThan(0);
    expect(DEFAULT_WK_CAP_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_5H_CAP_TOKENS)).toBe(true);
    expect(Number.isInteger(DEFAULT_WK_CAP_TOKENS)).toBe(true);
  });
});

// ---------- budgetProbePath ----------

describe("budgetProbePath", () => {
  test("appends state/budget-probe-<team>.json to atmuxDir", () => {
    expect(budgetProbePath("/tmp/foo", "atmux")).toBe(
      "/tmp/foo/state/budget-probe-atmux.json",
    );
  });

  test("preserves the exact team name in the filename (no transformation)", () => {
    expect(budgetProbePath("/x", "ifca-aux")).toBe("/x/state/budget-probe-ifca-aux.json");
  });
});

// ---------- parseBudgetSpec ----------

describe("parseBudgetSpec — raw int forms", () => {
  test("`0` parses as raw 0", () => {
    expect(parseBudgetSpec("0")).toEqual({ kind: "raw", tokens: 0 });
  });

  test("`1000000` parses as raw 1M", () => {
    expect(parseBudgetSpec("1000000")).toEqual({ kind: "raw", tokens: 1_000_000 });
  });

  test("very large raw number parses without overflow", () => {
    expect(parseBudgetSpec("999999999999")).toEqual({
      kind: "raw",
      tokens: 999_999_999_999,
    });
  });
});

describe("parseBudgetSpec — percentage forms", () => {
  test("bare `30%` defaults to pct-wk window per ADR-052", () => {
    expect(parseBudgetSpec("30%")).toEqual({ kind: "pct-wk", pct: 30 });
  });

  test("`30%-wk` explicit weekly", () => {
    expect(parseBudgetSpec("30%-wk")).toEqual({ kind: "pct-wk", pct: 30 });
  });

  test("`50%-5h` explicit 5h", () => {
    expect(parseBudgetSpec("50%-5h")).toEqual({ kind: "pct-5h", pct: 50 });
  });

  test("`0%` is allowed (no-budget inhibitor for rollback per ADR-052)", () => {
    expect(parseBudgetSpec("0%")).toEqual({ kind: "pct-wk", pct: 0 });
  });

  test("`100%` is allowed (full-budget edge case)", () => {
    expect(parseBudgetSpec("100%")).toEqual({ kind: "pct-wk", pct: 100 });
  });
});

describe("parseBudgetSpec — rejection cases", () => {
  test("`101%` rejected (>100)", () => {
    expect(parseBudgetSpec("101%")).toBeNull();
  });

  test("`200%-wk` rejected (>100)", () => {
    expect(parseBudgetSpec("200%-wk")).toBeNull();
  });

  test("malformed string `30 wk` rejected (whitespace)", () => {
    expect(parseBudgetSpec("30 wk")).toBeNull();
  });

  test("malformed `30%-day` rejected (unknown window)", () => {
    expect(parseBudgetSpec("30%-day")).toBeNull();
  });

  test("malformed `abc` rejected", () => {
    expect(parseBudgetSpec("abc")).toBeNull();
  });

  test("empty string rejected", () => {
    expect(parseBudgetSpec("")).toBeNull();
  });

  test("negative `-30%` rejected (regex requires leading digit)", () => {
    expect(parseBudgetSpec("-30%")).toBeNull();
  });

  test("decimal `30.5%` rejected (regex is integer-only)", () => {
    expect(parseBudgetSpec("30.5%")).toBeNull();
  });
});

// ---------- BudgetProbe schema ----------

describe("schema — BudgetProbe", () => {
  test("accepts an empty object (both fields optional)", () => {
    expect(BudgetProbe.parse({})).toEqual({});
  });

  test("accepts h5_util only", () => {
    const ok = BudgetProbe.parse({ h5_util: 0.42 });
    expect(ok.h5_util).toBe(0.42);
    expect(ok.wk_util).toBeUndefined();
  });

  test("accepts wk_util only", () => {
    const ok = BudgetProbe.parse({ wk_util: 0.18 });
    expect(ok.wk_util).toBe(0.18);
  });

  test("accepts both fields + passes through extras", () => {
    const ok = BudgetProbe.parse({ h5_util: 0.5, wk_util: 0.3, extra: "future" });
    expect(ok.h5_util).toBe(0.5);
    expect(ok.wk_util).toBe(0.3);
    expect((ok as Record<string, unknown>).extra).toBe("future");
  });

  test("rejects negative h5_util", () => {
    expect(() => BudgetProbe.parse({ h5_util: -0.1 })).toThrow();
  });

  test("rejects negative wk_util", () => {
    expect(() => BudgetProbe.parse({ wk_util: -0.5 })).toThrow();
  });
});

// ---------- readBudgetProbe ----------

describe("readBudgetProbe", () => {
  test("returns null when probe file is absent", async () => {
    expect(await readBudgetProbe(atmuxDir, "atmux")).toBeNull();
  });

  test("returns parsed probe when file is present", async () => {
    await writeFile(
      budgetProbePath(atmuxDir, "atmux"),
      JSON.stringify({ h5_util: 0.6, wk_util: 0.2 }),
    );
    const got = await readBudgetProbe(atmuxDir, "atmux");
    expect(got).toEqual({ h5_util: 0.6, wk_util: 0.2 });
  });

  test("filename includes the team name (per-team isolation)", async () => {
    await writeFile(
      budgetProbePath(atmuxDir, "sopx"),
      JSON.stringify({ h5_util: 0.1, wk_util: 0.05 }),
    );
    expect(await readBudgetProbe(atmuxDir, "atmux")).toBeNull();
    expect(await readBudgetProbe(atmuxDir, "sopx")).toEqual({
      h5_util: 0.1,
      wk_util: 0.05,
    });
  });

  test("throws SchemaError on malformed JSON file", async () => {
    await writeFile(budgetProbePath(atmuxDir, "atmux"), "{not json");
    await expect(readBudgetProbe(atmuxDir, "atmux")).rejects.toBeInstanceOf(SchemaError);
  });

  test("throws SchemaError on shape-mismatch (negative util)", async () => {
    await writeFile(
      budgetProbePath(atmuxDir, "atmux"),
      JSON.stringify({ h5_util: -1 }),
    );
    await expect(readBudgetProbe(atmuxDir, "atmux")).rejects.toBeInstanceOf(SchemaError);
  });
});

// ---------- resolveBudget ----------

describe("resolveBudget — raw kind", () => {
  test("returns the raw token total verbatim", () => {
    expect(resolveBudget({ kind: "raw", tokens: 1_500_000 })).toEqual({
      total: 1_500_000,
      formula: "raw=1500000",
    });
  });

  test("raw 0 is allowed (rollback path)", () => {
    expect(resolveBudget({ kind: "raw", tokens: 0 })).toEqual({
      total: 0,
      formula: "raw=0",
    });
  });

  test("raw works without a probe (no IO needed)", () => {
    // Asserts the early-return short-circuits before the probe check.
    expect(resolveBudget({ kind: "raw", tokens: 100 })).not.toBeNull();
  });
});

describe("resolveBudget — pct kinds without probe → null", () => {
  test("pct-wk without probe returns null (fail-closed)", () => {
    expect(resolveBudget({ kind: "pct-wk", pct: 30 })).toBeNull();
  });

  test("pct-5h without probe returns null", () => {
    expect(resolveBudget({ kind: "pct-5h", pct: 50 })).toBeNull();
  });

  test("pct-wk with explicit null probe returns null", () => {
    expect(resolveBudget({ kind: "pct-wk", pct: 30 }, { probe: null })).toBeNull();
  });
});

describe("resolveBudget — pct-wk with probe", () => {
  test("30% × (1 − 0) × 100M = 30M tokens", () => {
    const got = resolveBudget(
      { kind: "pct-wk", pct: 30 },
      { probe: { wk_util: 0 } },
    );
    expect(got?.total).toBe(30_000_000);
    expect(got?.formula).toContain("30%");
    expect(got?.formula).toContain("wk_util=0.00");
  });

  test("30% × (1 − 0.5) × 100M = 15M tokens", () => {
    const got = resolveBudget(
      { kind: "pct-wk", pct: 30 },
      { probe: { wk_util: 0.5 } },
    );
    expect(got?.total).toBe(15_000_000);
  });

  test("missing wk_util defaults to 0 (full remaining)", () => {
    const got = resolveBudget({ kind: "pct-wk", pct: 30 }, { probe: {} });
    expect(got?.total).toBe(30_000_000);
  });

  test("util > 1 clamps remaining to 0", () => {
    const got = resolveBudget(
      { kind: "pct-wk", pct: 30 },
      { probe: { wk_util: 1.5 } },
    );
    expect(got?.total).toBe(0);
  });

  test("capWk override is honored", () => {
    const got = resolveBudget(
      { kind: "pct-wk", pct: 50 },
      { probe: { wk_util: 0 }, capWk: 1_000 },
    );
    expect(got?.total).toBe(500);
    expect(got?.formula).toContain("capWk=1000");
  });
});

describe("resolveBudget — pct-5h with probe", () => {
  test("50% × (1 − 0) × 5M = 2.5M tokens", () => {
    const got = resolveBudget(
      { kind: "pct-5h", pct: 50 },
      { probe: { h5_util: 0 } },
    );
    expect(got?.total).toBe(2_500_000);
    expect(got?.formula).toContain("h5_util=0.00");
    expect(got?.formula).toContain("cap5h=5000000");
  });

  test("50% × (1 − 0.4) × 5M = 1.5M tokens", () => {
    const got = resolveBudget(
      { kind: "pct-5h", pct: 50 },
      { probe: { h5_util: 0.4 } },
    );
    expect(got?.total).toBe(1_500_000);
  });

  test("missing h5_util defaults to 0", () => {
    const got = resolveBudget({ kind: "pct-5h", pct: 50 }, { probe: {} });
    expect(got?.total).toBe(2_500_000);
  });

  test("cap5h override is honored", () => {
    const got = resolveBudget(
      { kind: "pct-5h", pct: 25 },
      { probe: { h5_util: 0 }, cap5h: 4_000 },
    );
    expect(got?.total).toBe(1_000);
    expect(got?.formula).toContain("cap5h=4000");
  });
});

describe("resolveBudget — formula formatting", () => {
  test("formula includes 2-decimal util display (matches dry-run output spec)", () => {
    const got = resolveBudget(
      { kind: "pct-wk", pct: 30 },
      { probe: { wk_util: 0.123456 } },
    );
    expect(got?.formula).toContain("wk_util=0.12");
  });

  test("0% returns 0 tokens regardless of probe", () => {
    const got = resolveBudget(
      { kind: "pct-wk", pct: 0 },
      { probe: { wk_util: 0 } },
    );
    expect(got?.total).toBe(0);
  });
});

// ---------- generateRunId ----------

describe("generateRunId", () => {
  test("default rng (Math.random) → ei-<8 hex chars>", () => {
    const id = generateRunId();
    expect(id).toMatch(/^ei-[0-9a-f]{8}$/);
  });

  test("deterministic with injected rng", () => {
    expect(generateRunId(() => 0)).toBe("ei-00000000");
    expect(generateRunId(() => 0.999_999_99)).toMatch(/^ei-[0-9a-f]{8}$/);
  });

  test("two consecutive default calls produce ei-prefixed ids of correct shape", () => {
    const a = generateRunId();
    const b = generateRunId();
    expect(a).toMatch(/^ei-[0-9a-f]{8}$/);
    expect(b).toMatch(/^ei-[0-9a-f]{8}$/);
    // No collision assertion — Math.random can theoretically repeat;
    // the format check is the load-bearing assertion.
  });

  test("rng=0.5 → mid-range hex", () => {
    // 0.5 × 0xff_ff_ff_ff = 0x7fff_ffff = 2147483647 = "7fffffff"
    expect(generateRunId(() => 0.5)).toBe("ei-7fffffff");
  });
});

// ---------- resolveBudgetSpec — precedence cascade ----------

describe("resolveBudgetSpec — precedence cascade", () => {
  test("CLI --budget wins over env + team.json + default", () => {
    const got = resolveBudgetSpec(
      { cliBudget: "1000000" },
      { ATMUX_IMPROVE_BUDGET: "50%-5h" },
      { improve: { defaultBudget: "10%-wk" } },
    );
    expect(got).toBe("1000000");
  });

  test("env wins over team.json + default when no CLI", () => {
    const got = resolveBudgetSpec(
      {},
      { ATMUX_IMPROVE_BUDGET: "50%-5h" },
      { improve: { defaultBudget: "10%-wk" } },
    );
    expect(got).toBe("50%-5h");
  });

  test("team.json wins over default when no CLI + no env", () => {
    const got = resolveBudgetSpec(
      {},
      {},
      { improve: { defaultBudget: "10%-wk" } },
    );
    expect(got).toBe("10%-wk");
  });

  test("default `30%-wk` when nothing set", () => {
    expect(resolveBudgetSpec({}, {}, {})).toBe(DEFAULT_BUDGET_SPEC);
  });

  test("empty CLI string falls through to env", () => {
    expect(
      resolveBudgetSpec(
        { cliBudget: "" },
        { ATMUX_IMPROVE_BUDGET: "20%-wk" },
        {},
      ),
    ).toBe("20%-wk");
  });

  test("empty env string falls through to team.json", () => {
    expect(
      resolveBudgetSpec({}, { ATMUX_IMPROVE_BUDGET: "" }, {
        improve: { defaultBudget: "5%-wk" },
      }),
    ).toBe("5%-wk");
  });

  test("undefined team falls through to default (no .improve to dereference)", () => {
    expect(resolveBudgetSpec({}, {}, null)).toBe(DEFAULT_BUDGET_SPEC);
  });

  test("non-string team.improve.defaultBudget ignored (falls through)", () => {
    expect(
      resolveBudgetSpec({}, {}, { improve: { defaultBudget: 12345 } }),
    ).toBe(DEFAULT_BUDGET_SPEC);
  });

  test("empty team.improve.defaultBudget falls through", () => {
    expect(
      resolveBudgetSpec({}, {}, { improve: { defaultBudget: "" } }),
    ).toBe(DEFAULT_BUDGET_SPEC);
  });
});
