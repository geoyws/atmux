// Unit tests for `.atmux/state/budget-refresh-soon-state.json` per-
// resetEpoch dedup state-file (ADR-053 R1-T6 §D7).
//
// Per-(account, window, resetEpoch) dedup, stale-entry sweep on epoch
// rollover, multi-cycle re-arming. Sister tests covering the
// orchestration (runBudgetCheck) live in tests/unit/core/whip-budget-
// check.test.ts; this file isolates the state-file lifecycle per
// ADR-053 §D7 "tests/unit/state/budget-refresh-soon-state.test.ts".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetRefreshSoonStatePath,
  hasRefreshSoonFired,
  loadRefreshSoonState,
  recordRefreshSoonFire,
  refreshSoonKey,
  type RefreshSoonState,
  wipeStaleEntries,
  writeRefreshSoonState,
} from "../../../src/core/budget-refresh-soon-state.ts";

let atmuxDir: string;

beforeEach(async () => {
  atmuxDir = await mkdtemp(join(tmpdir(), "atmux-refresh-state-"));
  await mkdir(join(atmuxDir, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(atmuxDir, { recursive: true, force: true });
});

// ---------- Path ----------

describe("budgetRefreshSoonStatePath", () => {
  test("appends state/budget-refresh-soon-state.json to atmuxDir", () => {
    expect(budgetRefreshSoonStatePath("/tmp/foo")).toBe(
      "/tmp/foo/state/budget-refresh-soon-state.json",
    );
  });
});

// ---------- Composite key ----------

describe("refreshSoonKey", () => {
  test("composes <account>:<window>:<resetEpoch>", () => {
    expect(refreshSoonKey("ifca", "5h", 1700000000)).toBe("ifca:5h:1700000000");
    expect(refreshSoonKey("icloud", "wk", 1701000000)).toBe("icloud:wk:1701000000");
  });
});

// ---------- Load / write round-trip ----------

describe("loadRefreshSoonState + writeRefreshSoonState", () => {
  test("absent file → empty map", async () => {
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("write → read round-trip preserves the flat key→epoch map", async () => {
    const original: RefreshSoonState = {
      "ifca:5h:1700000000": 1699999990,
    };
    await writeRefreshSoonState(atmuxDir, original);
    expect(await loadRefreshSoonState(atmuxDir)).toEqual(original);
  });

  test("malformed JSON → empty map (corrupt-fresh recovery)", async () => {
    await writeFile(budgetRefreshSoonStatePath(atmuxDir), "{not json");
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("non-object root → empty map", async () => {
    await writeFile(budgetRefreshSoonStatePath(atmuxDir), "[1,2]");
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({});
  });

  test("non-numeric values stripped on load", async () => {
    await writeFile(
      budgetRefreshSoonStatePath(atmuxDir),
      JSON.stringify({ "ifca:5h:1": 100, "junk": "string" }),
    );
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({ "ifca:5h:1": 100 });
  });
});

// ---------- hasRefreshSoonFired ----------

describe("hasRefreshSoonFired", () => {
  test("false on empty state", () => {
    expect(hasRefreshSoonFired({}, "ifca", "5h", 1700000000)).toBe(false);
  });

  test("true when (account, window, resetEpoch) was previously fired", () => {
    const s = recordRefreshSoonFire({}, "ifca", "5h", 1700000000, 1699999990);
    expect(hasRefreshSoonFired(s, "ifca", "5h", 1700000000)).toBe(true);
  });

  test("scoped per resetEpoch — different reset = not fired (re-arms per cycle)", () => {
    const s = recordRefreshSoonFire({}, "ifca", "5h", 1700000000, 1699999990);
    expect(hasRefreshSoonFired(s, "ifca", "5h", 1700001000)).toBe(false);
  });

  test("scoped per account — different account = not fired", () => {
    const s = recordRefreshSoonFire({}, "ifca", "5h", 1700000000, 1699999990);
    expect(hasRefreshSoonFired(s, "icloud", "5h", 1700000000)).toBe(false);
  });

  test("scoped per window — 5h vs wk are independent", () => {
    const s = recordRefreshSoonFire({}, "ifca", "5h", 1700000000, 1699999990);
    expect(hasRefreshSoonFired(s, "ifca", "wk", 1700000000)).toBe(false);
  });
});

// ---------- recordRefreshSoonFire ----------

describe("recordRefreshSoonFire", () => {
  test("appends without losing prior fires", () => {
    let s: RefreshSoonState = {};
    s = recordRefreshSoonFire(s, "ifca", "5h", 1700000000, 1699999990);
    s = recordRefreshSoonFire(s, "ifca", "wk", 1700100000, 1700099990);
    expect(hasRefreshSoonFired(s, "ifca", "5h", 1700000000)).toBe(true);
    expect(hasRefreshSoonFired(s, "ifca", "wk", 1700100000)).toBe(true);
  });

  test("re-firing the same (account, window, resetEpoch) overwrites timestamp", () => {
    let s: RefreshSoonState = {};
    s = recordRefreshSoonFire(s, "ifca", "5h", 1700000000, 1);
    s = recordRefreshSoonFire(s, "ifca", "5h", 1700000000, 999);
    expect(s[refreshSoonKey("ifca", "5h", 1700000000)]).toBe(999);
  });
});

// ---------- wipeStaleEntries ----------

describe("wipeStaleEntries", () => {
  test("returns same state when nothing is stale", () => {
    const seeded = recordRefreshSoonFire({}, "ifca", "5h", 1700000000, 1699999990);
    const next = wipeStaleEntries(seeded, 1699999000); // before reset
    expect(next).toBe(seeded);
  });

  test("drops entries whose resetEpoch ≤ nowSec", () => {
    let s: RefreshSoonState = {};
    s = recordRefreshSoonFire(s, "ifca", "5h", 1, 0);     // stale
    s = recordRefreshSoonFire(s, "ifca", "wk", 100, 99);  // stale
    s = recordRefreshSoonFire(s, "ifca", "5h", 1000, 990); // fresh
    const next = wipeStaleEntries(s, 500);
    expect(next).toEqual({ "ifca:5h:1000": 990 });
  });

  test("multi-account staleness handled independently", () => {
    let s: RefreshSoonState = {};
    s = recordRefreshSoonFire(s, "ifca", "5h", 100, 50);    // stale
    s = recordRefreshSoonFire(s, "icloud", "5h", 1000, 990); // fresh
    const next = wipeStaleEntries(s, 200);
    expect(hasRefreshSoonFired(next, "ifca", "5h", 100)).toBe(false);
    expect(hasRefreshSoonFired(next, "icloud", "5h", 1000)).toBe(true);
  });

  test("malformed key (no parseable resetEpoch tail) is preserved (defensive)", () => {
    const s: RefreshSoonState = { "weird-key-no-colons": 100 };
    const next = wipeStaleEntries(s, 1000);
    expect(next).toEqual(s); // can't determine staleness — keep
  });

  test("equal-to-nowSec is treated as stale (boundary)", () => {
    const s: RefreshSoonState = { "ifca:5h:100": 50 };
    const next = wipeStaleEntries(s, 100);
    expect(next).toEqual({});
  });
});

// ---------- Multi-cycle re-arming ----------

describe("multi-cycle re-arming", () => {
  test("after wipeStaleEntries clears a cycle, the next cycle's resetEpoch is fresh-fire-able", () => {
    let s: RefreshSoonState = {};
    s = recordRefreshSoonFire(s, "ifca", "5h", 100, 50);
    s = wipeStaleEntries(s, 200);
    expect(hasRefreshSoonFired(s, "ifca", "5h", 100)).toBe(false);
    // Next cycle's resetEpoch — should be re-fire-able.
    expect(hasRefreshSoonFired(s, "ifca", "5h", 1000)).toBe(false);
    s = recordRefreshSoonFire(s, "ifca", "5h", 1000, 990);
    expect(hasRefreshSoonFired(s, "ifca", "5h", 1000)).toBe(true);
  });
});

// ---------- File IO ----------

describe("file IO", () => {
  test("writeRefreshSoonState produces JSON the bash side can cat-read", async () => {
    const s: RefreshSoonState = { "ifca:5h:1700000000": 1699999990 };
    await writeRefreshSoonState(atmuxDir, s);
    const text = await readFile(budgetRefreshSoonStatePath(atmuxDir), "utf8");
    expect(JSON.parse(text)).toEqual(s);
  });

  test("writeRefreshSoonState overwrites existing file", async () => {
    await writeRefreshSoonState(atmuxDir, { "k1": 1 });
    await writeRefreshSoonState(atmuxDir, { "k2": 2 });
    expect(await loadRefreshSoonState(atmuxDir)).toEqual({ "k2": 2 });
  });
});
