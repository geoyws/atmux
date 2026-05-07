// Unit tests for src/core/budget-pause.ts (ADR-053 §D2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AtRiskMember,
  type BudgetPauseState,
  budgetPauseStatePath,
  clearBudgetPauseState,
  isBudgetPauseActive,
  loadBudgetPauseState,
  writeBudgetPauseState,
} from "../../../src/core/budget-pause.ts";

let atmuxDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-bp-state-"));
  atmuxDir = join(tmp, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

const sampleAtRisk: AtRiskMember[] = [
  { member: "alpha", h5: 95, wk: 80 },
  { member: "beta", h5: 88, wk: 92 },
];

const sampleState = (overrides: Partial<BudgetPauseState> = {}): BudgetPauseState => ({
  paused: true,
  pausedAt: 1_700_000_000,
  pausedAtTs: "11:44 MYT",
  atRisk: sampleAtRisk,
  ...overrides,
});

describe("budgetPauseStatePath", () => {
  test("resolves to <atmuxDir>/state/budget-pause.json", () => {
    expect(budgetPauseStatePath("/foo/.atmux")).toBe("/foo/.atmux/state/budget-pause.json");
  });
});

describe("isBudgetPauseActive / loadBudgetPauseState (file absent)", () => {
  test("absent state file → not active, load returns null", async () => {
    expect(await isBudgetPauseActive(atmuxDir)).toBe(false);
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });
});

describe("writeBudgetPauseState + roundtrip", () => {
  test("write then load returns the same state shape", async () => {
    await writeBudgetPauseState(atmuxDir, sampleState());
    const loaded = await loadBudgetPauseState(atmuxDir);
    expect(loaded?.paused).toBe(true);
    expect(loaded?.pausedAt).toBe(1_700_000_000);
    expect(loaded?.pausedAtTs).toBe("11:44 MYT");
    expect(loaded?.atRisk).toEqual(sampleAtRisk);
  });

  test("write produces bash-compatible JSON shape (no schema-version)", async () => {
    await writeBudgetPauseState(atmuxDir, sampleState());
    const txt = await readFile(budgetPauseStatePath(atmuxDir), "utf8");
    const raw = JSON.parse(txt);
    // Bash readers expect exactly these top-level keys.
    expect(Object.keys(raw).sort()).toEqual(["atRisk", "paused", "pausedAt", "pausedAtTs"]);
    expect(raw.paused).toBe(true);
  });

  test("isBudgetPauseActive returns true after write", async () => {
    await writeBudgetPauseState(atmuxDir, sampleState());
    expect(await isBudgetPauseActive(atmuxDir)).toBe(true);
  });
});

describe("clearBudgetPauseState", () => {
  test("removes the file (active → inactive)", async () => {
    await writeBudgetPauseState(atmuxDir, sampleState());
    expect(await isBudgetPauseActive(atmuxDir)).toBe(true);
    await clearBudgetPauseState(atmuxDir);
    expect(await isBudgetPauseActive(atmuxDir)).toBe(false);
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("idempotent on absent file", async () => {
    await clearBudgetPauseState(atmuxDir); // no throw
    await clearBudgetPauseState(atmuxDir); // still no throw
    expect(await isBudgetPauseActive(atmuxDir)).toBe(false);
  });
});

describe("loadBudgetPauseState — defensive shape checks", () => {
  test("malformed JSON → null (treat as not paused; next tick rewrites)", async () => {
    await writeFile(budgetPauseStatePath(atmuxDir), "not json{");
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
    expect(await isBudgetPauseActive(atmuxDir)).toBe(false);
  });

  test("paused=false in state → load returns null (rest-state shape)", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({ paused: false, pausedAt: 0, pausedAtTs: "", atRisk: [] }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("missing pausedAt → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({ paused: true, pausedAtTs: "", atRisk: [] }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("missing pausedAtTs → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({ paused: true, pausedAt: 0, atRisk: [] }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("atRisk entry with non-string member → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({
        paused: true,
        pausedAt: 0,
        pausedAtTs: "",
        atRisk: [{ member: 42, h5: 95, wk: 80 }],
      }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("atRisk entry with non-number h5 → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({
        paused: true,
        pausedAt: 0,
        pausedAtTs: "",
        atRisk: [{ member: "alpha", h5: "high", wk: 80 }],
      }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("atRisk not an array → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({ paused: true, pausedAt: 0, pausedAtTs: "", atRisk: "wrong" }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("atRisk entry not an object → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({ paused: true, pausedAt: 0, pausedAtTs: "", atRisk: ["string"] }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("atRisk entry with non-number wk → null", async () => {
    await writeFile(
      budgetPauseStatePath(atmuxDir),
      JSON.stringify({
        paused: true,
        pausedAt: 0,
        pausedAtTs: "",
        atRisk: [{ member: "alpha", h5: 95, wk: "high" }],
      }),
    );
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });

  test("non-object root → null", async () => {
    await writeFile(budgetPauseStatePath(atmuxDir), JSON.stringify(["array"]));
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
    await writeFile(budgetPauseStatePath(atmuxDir), JSON.stringify(null));
    expect(await loadBudgetPauseState(atmuxDir)).toBeNull();
  });
});
