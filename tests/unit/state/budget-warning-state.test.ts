// Unit tests for `.atmux/state/budget-warning-state.json` band-crossing
// dedup state-file (ADR-053 R1-T6 §D7).
//
// Band-crossing dedup, window-reset wipe + restamp, multi-(account,
// window) sequencing. Sister tests covering the higher-level orchestration
// (runBudgetCheck) live in tests/unit/core/whip-budget-check.test.ts;
// this file isolates the state-file lifecycle per ADR-053 §D7
// "tests/unit/state/budget-warning-state.test.ts".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetWarningStatePath,
  hasBandFired,
  loadWarningState,
  recordBandFire,
  warningKey,
  type WarningState,
  wipeForResetWindow,
  writeWarningState,
} from "../../../src/core/budget-warning-state.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-band-state-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Path ----------

describe("budgetWarningStatePath", () => {
  test("appends state/budget-warning-state.json to atmuxDir", () => {
    expect(budgetWarningStatePath("/tmp/foo")).toBe(
      "/tmp/foo/state/budget-warning-state.json",
    );
  });
});

// ---------- Composite key ----------

describe("warningKey", () => {
  test("composes <account>:<window>:<band-fraction>", () => {
    expect(warningKey("ifca", "5h", 0.5)).toBe("ifca:5h:0.5");
    expect(warningKey("icloud", "wk", 0.25)).toBe("icloud:wk:0.25");
  });
});

// ---------- Load / write round-trip ----------

describe("loadWarningState + writeWarningState", () => {
  test("absent file → empty WarningState", async () => {
    const s = await loadWarningState(atmuxDir);
    expect(s).toEqual({});
  });

  test("write → read round-trip preserves the flat key→epoch map", async () => {
    const original: WarningState = {
      "ifca:5h:0.5": 1700000010,
      "ifca:5h:0.25": 1700000020,
    };
    await writeWarningState(atmuxDir, original);
    const loaded = await loadWarningState(atmuxDir);
    expect(loaded).toEqual(original);
  });

  test("malformed JSON → empty map (corrupt-fresh recovery)", async () => {
    await writeFile(budgetWarningStatePath(atmuxDir), "{not json");
    const s = await loadWarningState(atmuxDir);
    expect(s).toEqual({});
  });

  test("non-object root (e.g. array) → empty map", async () => {
    await writeFile(budgetWarningStatePath(atmuxDir), "[1,2,3]");
    const s = await loadWarningState(atmuxDir);
    expect(s).toEqual({});
  });

  test("non-numeric values are stripped on load (defensive)", async () => {
    await writeFile(
      budgetWarningStatePath(atmuxDir),
      JSON.stringify({ "ifca:5h:0.5": 1, "junk": "string-value", "nan": Number.NaN }),
    );
    const s = await loadWarningState(atmuxDir);
    expect(s).toEqual({ "ifca:5h:0.5": 1 });
  });
});

// ---------- hasBandFired ----------

describe("hasBandFired", () => {
  test("false on empty state", () => {
    expect(hasBandFired({}, "ifca", "5h", 0.5)).toBe(false);
  });

  test("true when (account, window, band) was previously recorded", () => {
    const s = recordBandFire({}, "ifca", "5h", 0.5, 1700000000);
    expect(hasBandFired(s, "ifca", "5h", 0.5)).toBe(true);
  });

  test("scoped per account — different account = not fired", () => {
    const s = recordBandFire({}, "ifca", "5h", 0.5, 1700000000);
    expect(hasBandFired(s, "icloud", "5h", 0.5)).toBe(false);
  });

  test("scoped per band — different band = not fired", () => {
    const s = recordBandFire({}, "ifca", "5h", 0.5, 1700000000);
    expect(hasBandFired(s, "ifca", "5h", 0.25)).toBe(false);
  });

  test("scoped per window — 5h vs wk are independent", () => {
    const s = recordBandFire({}, "ifca", "5h", 0.5, 1700000000);
    expect(hasBandFired(s, "ifca", "wk", 0.5)).toBe(false);
  });
});

// ---------- recordBandFire ----------

describe("recordBandFire", () => {
  test("records firing without losing prior bands", () => {
    let s: WarningState = {};
    s = recordBandFire(s, "ifca", "5h", 0.5, 1700000010);
    s = recordBandFire(s, "ifca", "5h", 0.25, 1700000020);
    expect(hasBandFired(s, "ifca", "5h", 0.5)).toBe(true);
    expect(hasBandFired(s, "ifca", "5h", 0.25)).toBe(true);
  });

  test("re-firing the same band overwrites the timestamp", () => {
    let s: WarningState = {};
    s = recordBandFire(s, "ifca", "5h", 0.5, 1);
    s = recordBandFire(s, "ifca", "5h", 0.5, 999);
    expect(s[warningKey("ifca", "5h", 0.5)]).toBe(999);
  });

  test("supports multiple (account, window) pairs simultaneously", () => {
    let s: WarningState = {};
    s = recordBandFire(s, "ifca", "5h", 0.5, 1);
    s = recordBandFire(s, "ifca", "wk", 0.5, 2);
    s = recordBandFire(s, "icloud", "5h", 0.5, 3);
    expect(hasBandFired(s, "ifca", "5h", 0.5)).toBe(true);
    expect(hasBandFired(s, "ifca", "wk", 0.5)).toBe(true);
    expect(hasBandFired(s, "icloud", "5h", 0.5)).toBe(true);
  });
});

// ---------- wipeForResetWindow ----------

describe("wipeForResetWindow", () => {
  test("first observation stamps the sentinel without wiping", () => {
    const s = wipeForResetWindow({}, "ifca", "5h", 1700000000);
    expect(s["ifca:5h:reset"]).toBe(1700000000);
  });

  test("returns same state when reset epoch matches prior", () => {
    const seeded = wipeForResetWindow({}, "ifca", "5h", 1700000000);
    const next = wipeForResetWindow(seeded, "ifca", "5h", 1700000000);
    expect(next).toBe(seeded);
  });

  test("wipes (account, window) entries when reset advances", () => {
    let s = wipeForResetWindow({}, "ifca", "5h", 1700000000);
    s = recordBandFire(s, "ifca", "5h", 0.5, 1700000010);
    s = recordBandFire(s, "ifca", "5h", 0.25, 1700000020);
    const next = wipeForResetWindow(s, "ifca", "5h", 1700001000); // advanced
    expect(hasBandFired(next, "ifca", "5h", 0.5)).toBe(false);
    expect(hasBandFired(next, "ifca", "5h", 0.25)).toBe(false);
    // Sentinel restamped to the new reset.
    expect(next["ifca:5h:reset"]).toBe(1700001000);
  });

  test("preserves OTHER (account, window) pairs while wiping the affected one", () => {
    let s: WarningState = wipeForResetWindow({}, "ifca", "5h", 1);
    s = wipeForResetWindow(s, "ifca", "wk", 100);
    s = wipeForResetWindow(s, "icloud", "5h", 200);
    s = recordBandFire(s, "ifca", "5h", 0.5, 5);
    s = recordBandFire(s, "ifca", "wk", 0.5, 105);
    s = recordBandFire(s, "icloud", "5h", 0.5, 205);
    // Advance only ifca:5h.
    const next = wipeForResetWindow(s, "ifca", "5h", 1000);
    expect(hasBandFired(next, "ifca", "5h", 0.5)).toBe(false);
    expect(hasBandFired(next, "ifca", "wk", 0.5)).toBe(true);
    expect(hasBandFired(next, "icloud", "5h", 0.5)).toBe(true);
  });

  test("clock-skew protection — backwards reset epoch is a no-op", () => {
    const seeded = wipeForResetWindow({}, "ifca", "5h", 1700000000);
    const next = wipeForResetWindow(seeded, "ifca", "5h", 1699000000); // earlier
    expect(next).toEqual(seeded);
  });
});

// ---------- File IO + persistence ----------

describe("file IO + persistence", () => {
  test("writeWarningState produces JSON the bash side can cat-read", async () => {
    const s: WarningState = { "ifca:5h:0.5": 1700000010 };
    await writeWarningState(atmuxDir, s);
    const text = await readFile(budgetWarningStatePath(atmuxDir), "utf8");
    expect(JSON.parse(text)).toEqual(s);
  });

  test("writeWarningState overwrites existing file", async () => {
    await writeWarningState(atmuxDir, { "k1": 1 });
    await writeWarningState(atmuxDir, { "k2": 2 });
    const after = await loadWarningState(atmuxDir);
    expect(after).toEqual({ "k2": 2 });
  });
});
