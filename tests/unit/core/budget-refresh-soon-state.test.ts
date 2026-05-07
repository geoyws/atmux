// Unit tests for src/core/budget-refresh-soon-state.ts (ADR-053 §D3 4.2).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetRefreshSoonStatePath,
  hasRefreshSoonFired,
  loadRefreshSoonState,
  recordRefreshSoonFire,
  type RefreshSoonState,
  refreshSoonKey,
  wipeStaleEntries,
  writeRefreshSoonState,
} from "../../../src/core/budget-refresh-soon-state.ts";

let atmuxDir: string;

beforeEach(async () => {
  const tmp = await mkdtemp(join(tmpdir(), "atmux-brss-"));
  atmuxDir = join(tmp, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true }).catch(() => {});
});

describe("budgetRefreshSoonStatePath", () => {
  test("resolves to <atmuxDir>/state/budget-refresh-soon-state.json", () => {
    expect(budgetRefreshSoonStatePath("/foo/.atmux")).toBe(
      "/foo/.atmux/state/budget-refresh-soon-state.json",
    );
  });
});

describe("refreshSoonKey", () => {
  test("composes <account>:<window>:<resetEpoch>", () => {
    expect(refreshSoonKey("icloud", "5h", 1_700_000_000)).toBe("icloud:5h:1700000000");
    expect(refreshSoonKey("unum", "wk", 0)).toBe("unum:wk:0");
  });
});

describe("loadRefreshSoonState (file flavours)", () => {
  test("absent file → empty state", async () => {
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("malformed JSON → empty", async () => {
    await writeFile(budgetRefreshSoonStatePath(atmuxDir), "not json{");
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("array root → empty", async () => {
    await writeFile(budgetRefreshSoonStatePath(atmuxDir), JSON.stringify([]));
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("null root → empty", async () => {
    await writeFile(budgetRefreshSoonStatePath(atmuxDir), JSON.stringify(null));
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("filters non-number values", async () => {
    await writeFile(
      budgetRefreshSoonStatePath(atmuxDir),
      JSON.stringify({
        "icloud:5h:1700000000": 1,
        "icloud:5h:1700604800": "wrong",
      }),
    );
    const s = await loadRefreshSoonState(atmuxDir);
    expect(s["icloud:5h:1700000000"]).toBe(1);
    expect(s["icloud:5h:1700604800"]).toBeUndefined();
  });
});

describe("writeRefreshSoonState round-trip", () => {
  test("roundtrips a small state map", async () => {
    const s: RefreshSoonState = {
      "icloud:5h:1700003600": 1_699_999_900,
      "icloud:wk:1700604800": 1_700_000_000,
    };
    await writeRefreshSoonState(atmuxDir, s);
    expect(await loadRefreshSoonState(atmuxDir)).toEqual(s);
  });
});

describe("hasRefreshSoonFired + recordRefreshSoonFire", () => {
  test("hasRefreshSoonFired false for absent triple", () => {
    expect(hasRefreshSoonFired({}, "icloud", "5h", 1_700_000_000)).toBe(false);
  });

  test("recordRefreshSoonFire stamps key + makes hasFired true", () => {
    const s = recordRefreshSoonFire({}, "icloud", "5h", 1_700_003_600, 1_700_000_000);
    expect(s["icloud:5h:1700003600"]).toBe(1_700_000_000);
    expect(hasRefreshSoonFired(s, "icloud", "5h", 1_700_003_600)).toBe(true);
  });

  test("recordRefreshSoonFire is purely functional (input not mutated)", () => {
    const before: RefreshSoonState = { "icloud:5h:1": 100 };
    const after = recordRefreshSoonFire(before, "unum", "wk", 2, 200);
    expect(before).toEqual({ "icloud:5h:1": 100 });
    expect(after).toEqual({ "icloud:5h:1": 100, "unum:wk:2": 200 });
  });
});

describe("wipeStaleEntries", () => {
  test("drops entries whose resetEpoch is ≤ nowSec", () => {
    const before: RefreshSoonState = {
      "icloud:5h:1700000000": 1, // reset at epoch 1.7B → stale at now=1.8B
      "icloud:wk:1800000000": 2, // future → kept
      "unum:5h:1700000500": 3, // stale
    };
    const after = wipeStaleEntries(before, 1_700_000_500);
    expect(Object.keys(after).sort()).toEqual(["icloud:wk:1800000000"]);
  });

  test("returns the same object reference when nothing wiped", () => {
    const before: RefreshSoonState = {
      "icloud:wk:1800000000": 1,
    };
    const after = wipeStaleEntries(before, 1_700_000_000);
    expect(after).toBe(before);
  });

  test("malformed key (no resetEpoch tail) is preserved", () => {
    // We don't aggressively prune corrupted keys — operator can clean
    // manually. Just don't crash.
    const before: RefreshSoonState = { weird_no_colons: 1 };
    const after = wipeStaleEntries(before, 1_800_000_000);
    expect(after).toEqual(before);
  });

  test("non-numeric reset tail is preserved (extractResetEpoch returns null)", () => {
    const before: RefreshSoonState = { "icloud:5h:not-a-number": 1 };
    const after = wipeStaleEntries(before, 1_800_000_000);
    expect(after).toEqual(before);
  });

  test("equal-to-now is treated as stale (boundary inclusive)", () => {
    const before: RefreshSoonState = { "icloud:5h:1700000000": 1 };
    const after = wipeStaleEntries(before, 1_700_000_000);
    expect(after).toEqual({});
  });
});
