// Unit tests for src/core/budget-warning-state.ts (ADR-053 §D3 4.1).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetWarningStatePath,
  hasBandFired,
  loadWarningState,
  recordBandFire,
  type WarningState,
  warningKey,
  wipeForResetWindow,
  writeWarningState,
} from "../../../src/core/budget-warning-state.ts";

let atmuxDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-bws-"));
  atmuxDir = join(tmp, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

describe("budgetWarningStatePath", () => {
  test("resolves to <atmuxDir>/state/budget-warning-state.json", () => {
    expect(budgetWarningStatePath("/foo/.atmux")).toBe(
      "/foo/.atmux/state/budget-warning-state.json",
    );
  });
});

describe("warningKey", () => {
  test("composes <account>:<window>:<band>", () => {
    expect(warningKey("icloud", "5h", 0.5)).toBe("icloud:5h:0.5");
    expect(warningKey("unum", "wk", 0.15)).toBe("unum:wk:0.15");
  });
});

describe("loadWarningState (file flavours)", () => {
  test("absent file → empty state", async () => {
    expect(await loadWarningState(atmuxDir)).toEqual({});
  });

  test("malformed JSON → empty state", async () => {
    await writeFile(budgetWarningStatePath(atmuxDir), "not json{");
    expect(await loadWarningState(atmuxDir)).toEqual({});
  });

  test("array root → empty state (must be object map)", async () => {
    await writeFile(budgetWarningStatePath(atmuxDir), JSON.stringify(["wrong"]));
    expect(await loadWarningState(atmuxDir)).toEqual({});
  });

  test("null root → empty state", async () => {
    await writeFile(budgetWarningStatePath(atmuxDir), JSON.stringify(null));
    expect(await loadWarningState(atmuxDir)).toEqual({});
  });

  test("filters non-finite + non-number values", async () => {
    await writeFile(
      budgetWarningStatePath(atmuxDir),
      JSON.stringify({
        "icloud:5h:0.5": 1_700_000_000,
        "icloud:5h:0.25": "not-number",
        "icloud:wk:0.5": Number.NaN.toString(),
        "unum:5h:0.5": -123,
      }),
    );
    const s = await loadWarningState(atmuxDir);
    expect(s["icloud:5h:0.5"]).toBe(1_700_000_000);
    expect(s["icloud:5h:0.25"]).toBeUndefined();
    expect(s["icloud:wk:0.5"]).toBeUndefined();
    expect(s["unum:5h:0.5"]).toBe(-123); // negative is finite, kept
  });
});

describe("writeWarningState round-trip", () => {
  test("write then load returns same shape", async () => {
    const s: WarningState = {
      "icloud:5h:0.5": 1_700_000_000,
      "icloud:wk:0.25": 1_700_000_500,
    };
    await writeWarningState(atmuxDir, s);
    expect(await loadWarningState(atmuxDir)).toEqual(s);
  });
});

describe("hasBandFired + recordBandFire", () => {
  test("hasBandFired false for absent key", () => {
    expect(hasBandFired({}, "icloud", "5h", 0.5)).toBe(false);
  });

  test("recordBandFire returns new state with band stamped", () => {
    const s = recordBandFire({}, "icloud", "5h", 0.5, 1_700_000_000);
    expect(s["icloud:5h:0.5"]).toBe(1_700_000_000);
    expect(hasBandFired(s, "icloud", "5h", 0.5)).toBe(true);
  });

  test("recordBandFire is purely functional (input not mutated)", () => {
    const before: WarningState = { "icloud:5h:0.5": 1 };
    const after = recordBandFire(before, "unum", "wk", 0.25, 2);
    expect(before).toEqual({ "icloud:5h:0.5": 1 });
    expect(after).toEqual({
      "icloud:5h:0.5": 1,
      "unum:wk:0.25": 2,
    });
  });
});

describe("wipeForResetWindow", () => {
  test("first observation (no sentinel) → stamps sentinel without wipe", () => {
    const before: WarningState = { "icloud:5h:0.5": 1 };
    const after = wipeForResetWindow(before, "icloud", "5h", 1_700_003_600);
    expect(after["icloud:5h:0.5"]).toBe(1);
    expect(after["icloud:5h:reset"]).toBe(1_700_003_600);
  });

  test("reset epoch matches sentinel → no-op", () => {
    const before: WarningState = {
      "icloud:5h:0.5": 1,
      "icloud:5h:reset": 1_700_003_600,
    };
    const after = wipeForResetWindow(before, "icloud", "5h", 1_700_003_600);
    expect(after).toEqual(before);
  });

  test("reset epoch advanced → wipes (account, window) keys + restamps sentinel", () => {
    const before: WarningState = {
      "icloud:5h:0.5": 1,
      "icloud:5h:0.25": 2,
      "icloud:5h:reset": 1_700_003_600,
      "icloud:wk:0.5": 3,
      "icloud:wk:reset": 1_700_604_800,
      "unum:5h:0.5": 4, // unrelated account — preserved
    };
    const after = wipeForResetWindow(before, "icloud", "5h", 1_700_007_200);
    expect(after["icloud:5h:0.5"]).toBeUndefined();
    expect(after["icloud:5h:0.25"]).toBeUndefined();
    expect(after["icloud:5h:reset"]).toBe(1_700_007_200); // restamped
    expect(after["icloud:wk:0.5"]).toBe(3); // preserved (different window)
    expect(after["icloud:wk:reset"]).toBe(1_700_604_800);
    expect(after["unum:5h:0.5"]).toBe(4); // preserved (different account)
  });

  test("reset went backwards (clock skew) → state unchanged", () => {
    const before: WarningState = {
      "icloud:5h:0.5": 1,
      "icloud:5h:reset": 1_700_003_600,
    };
    const after = wipeForResetWindow(before, "icloud", "5h", 1_700_000_000);
    expect(after).toEqual(before);
  });

  test("non-mutating: returns state object as-is on no-op", () => {
    const before: WarningState = {
      "icloud:5h:reset": 1_700_003_600,
    };
    const after = wipeForResetWindow(before, "icloud", "5h", 1_700_003_600);
    expect(after).toBe(before); // reference equality on no-op
  });
});
