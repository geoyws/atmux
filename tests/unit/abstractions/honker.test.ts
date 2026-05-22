// Unit tests for src/abstractions/honker.ts.
//
// Pins ADR-202 §D2 kill-switch + §D5 load-or-fallback semantics:
//   - Default-off: no `ATMUX_HONKER` env → returns `{loaded: false}`
//     without touching the DB. Phase-1 ships with the substrate gated.
//   - Kill-switch on + extension load succeeds + smoke passes → loaded.
//   - Kill-switch on + load throws → graceful fallback with reason.
//   - Kill-switch on + load succeeds but smoke fails → graceful fallback.
//   - macOS: `setCustomSQLite` fires before loadExtension; failure here
//     also falls back (Apple's bundled sqlite has extension loading
//     disabled — friction documented in ADR-202 §D5/§D7).
//   - Linux: no setCustomSQLite call (distro sqlite supports
//     enable_load_extension natively).
//
// All tests use the `HonkerHooks` test-injection seam — no real
// extension binary required (it isn't shipped yet per the Phase-1
// scope clarification in ADR-202 §D12).

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bootHonker,
  getHonkerState,
  isHonkerEnabled,
  loadHonkerOrFallback,
  resetHonkerStateForTest,
} from "../../../src/abstractions/honker.ts";

describe("isHonkerEnabled", () => {
  // 2026-05-21: default flipped off → on per driver-initiated dogfood.
  // Substrate is graceful (binary-absent → poll-mode fallback), so
  // default-on is safe to enable before the binary ships universally.
  test("default-ON when env var absent (post-2026-05-21 dogfood flip)", () => {
    expect(isHonkerEnabled({})).toBe(true);
  });

  test("default-ON when env var is empty string", () => {
    expect(isHonkerEnabled({ ATMUX_HONKER: "" })).toBe(true);
  });

  test("explicit off forms still disable", () => {
    expect(isHonkerEnabled({ ATMUX_HONKER: "off" })).toBe(false);
    expect(isHonkerEnabled({ ATMUX_HONKER: "0" })).toBe(false);
    expect(isHonkerEnabled({ ATMUX_HONKER: "false" })).toBe(false);
    expect(isHonkerEnabled({ ATMUX_HONKER: "OFF" })).toBe(false);
    expect(isHonkerEnabled({ ATMUX_HONKER: "FALSE" })).toBe(false);
  });

  test("on for truthy values (back-compat — explicit-on still honored)", () => {
    expect(isHonkerEnabled({ ATMUX_HONKER: "on" })).toBe(true);
    expect(isHonkerEnabled({ ATMUX_HONKER: "ON" })).toBe(true);
    expect(isHonkerEnabled({ ATMUX_HONKER: "1" })).toBe(true);
    expect(isHonkerEnabled({ ATMUX_HONKER: "true" })).toBe(true);
    expect(isHonkerEnabled({ ATMUX_HONKER: "TRUE" })).toBe(true);
  });

  test("trims whitespace before reading", () => {
    expect(isHonkerEnabled({ ATMUX_HONKER: "  on  " })).toBe(true);
    expect(isHonkerEnabled({ ATMUX_HONKER: "  off  " })).toBe(false);
  });

  test("garbage value falls back to default-on (positive form)", () => {
    // Anything that isn't an explicit off-form returns true. This keeps
    // typos like ATMUX_HONKER=onn from silently disabling the substrate.
    expect(isHonkerEnabled({ ATMUX_HONKER: "yes" })).toBe(true);
    expect(isHonkerEnabled({ ATMUX_HONKER: "garbage" })).toBe(true);
  });
});

describe("loadHonkerOrFallback — kill-switch off", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  test("returns {loaded: false} cleanly when kill-switch explicit off", () => {
    const state = loadHonkerOrFallback(db, { env: { ATMUX_HONKER: "off" } });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toBeNull();
    expect(state.extensionPath).toBeNull();
  });

  test("does not invoke load hooks when kill-switch off", () => {
    let loadCalled = false;
    let smokeCalled = false;
    loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "off" },
      loadExtension: () => {
        loadCalled = true;
      },
      smokeProbe: () => {
        smokeCalled = true;
        return true;
      },
    });
    expect(loadCalled).toBe(false);
    expect(smokeCalled).toBe(false);
  });
});

describe("loadHonkerOrFallback — Linux (no setCustomSQLite preamble)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  test("happy path: load + smoke green → {loaded: true}", () => {
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/test", ATMUX_HONKER_PATH: "/test/honker.so" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(state.loaded).toBe(true);
    expect(state.fallbackReason).toBeNull();
    expect(state.extensionPath).toBe("/test/honker.so");
  });

  test("default extension path uses HOME + .so on linux", () => {
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(state.extensionPath).toBe("/root/.atmux/extensions/honker.so");
  });

  test("loadExtension throws → graceful fallback with reason", () => {
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {
        throw new Error("no such file");
      },
      smokeProbe: () => true,
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/loadExtension/);
    expect(state.fallbackReason).toMatch(/no such file/);
    expect(state.extensionPath).toBe("/root/.atmux/extensions/honker.so");
  });

  test("smoke probe returns false → graceful fallback", () => {
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => false,
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/smoke probe returned false/);
  });

  test("smoke probe throws → graceful fallback with reason", () => {
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => {
        throw new Error("not a function");
      },
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/smoke probe threw/);
    expect(state.fallbackReason).toMatch(/not a function/);
  });
});

describe("loadHonkerOrFallback — macOS (setCustomSQLite preamble)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  test("default extension path uses HOME + .dylib on darwin", () => {
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/Users/dev" },
      platform: "darwin",
      setCustomSQLite: () => {},
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(state.extensionPath).toBe("/Users/dev/.atmux/extensions/honker.dylib");
  });

  test("setCustomSQLite fires before loadExtension on darwin", () => {
    const order: string[] = [];
    loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/Users/dev" },
      platform: "darwin",
      setCustomSQLite: (p) => {
        order.push(`setCustomSQLite(${p})`);
      },
      loadExtension: () => {
        order.push("loadExtension");
      },
      smokeProbe: () => {
        order.push("smokeProbe");
        return true;
      },
    });
    expect(order).toEqual([
      "setCustomSQLite(/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib)",
      "loadExtension",
      "smokeProbe",
    ]);
  });

  test("ATMUX_HONKER_MAC_SQLITE overrides the Homebrew default path", () => {
    let observed = "";
    loadHonkerOrFallback(db, {
      env: {
        ATMUX_HONKER: "on",
        HOME: "/Users/dev",
        ATMUX_HONKER_MAC_SQLITE: "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
      },
      platform: "darwin",
      setCustomSQLite: (p) => {
        observed = p;
      },
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(observed).toBe("/usr/local/opt/sqlite/lib/libsqlite3.dylib");
  });

  test("setCustomSQLite throws → graceful fallback with reason (and loadExtension never fires)", () => {
    let loadCalled = false;
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/Users/dev" },
      platform: "darwin",
      setCustomSQLite: () => {
        throw new Error("brew sqlite missing");
      },
      loadExtension: () => {
        loadCalled = true;
      },
      smokeProbe: () => true,
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/setCustomSQLite/);
    expect(state.fallbackReason).toMatch(/brew sqlite missing/);
    expect(loadCalled).toBe(false);
  });

  test("does not call setCustomSQLite on linux even if hook is provided", () => {
    let setCalled = false;
    loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      setCustomSQLite: () => {
        setCalled = true;
      },
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(setCalled).toBe(false);
  });
});

describe("loadHonkerOrFallback — production bun:sqlite path (no hooks injected)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => db.close());

  test("real bun:sqlite loadExtension against missing path → graceful fallback", () => {
    // No `loadExtension` hook → real `db.loadExtension(path)` fires.
    // Extension file doesn't exist; bun:sqlite throws; we catch + fallback.
    // This exercises lines 137-145 (production load path) without needing
    // the shipped extension binary.
    const state = loadHonkerOrFallback(db, {
      env: {
        ATMUX_HONKER: "on",
        HOME: "/root",
        ATMUX_HONKER_PATH: "/nonexistent/path/honker.so",
      },
      platform: "linux",
      // No loadExtension hook — uses real db.loadExtension()
      // No smokeProbe hook needed (load fails first)
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/loadExtension/);
    expect(state.extensionPath).toBe("/nonexistent/path/honker.so");
  });

  test("darwin no-hook path — fake constructor exposes setCustomSQLite static (real production shape)", () => {
    // Production bun:sqlite shape: Database.constructor has
    // setCustomSQLite as a static method. Simulate with a fake db
    // whose constructor exposes it, to exercise lines 108-110.
    let staticCalled = "";
    const fakeDb = {
      constructor: {
        setCustomSQLite: (p: string) => {
          staticCalled = p;
        },
      },
    } as unknown as Database;
    const state = loadHonkerOrFallback(fakeDb, {
      env: { ATMUX_HONKER: "on", HOME: "/Users/dev" },
      platform: "darwin",
      // NO setCustomSQLite hook → uses the late-bound constructor lookup
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(staticCalled).toBe("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
    expect(state.loaded).toBe(true);
  });

  test("darwin no-hook path — fake constructor MISSING setCustomSQLite → fallback with reason", () => {
    // The other half of the late-bound darwin path: when bun's
    // Database.setCustomSQLite is genuinely unavailable (e.g. test
    // runtime that lacks the static), we fall back gracefully.
    // Exercises lines 113-121.
    const fakeDb = {
      constructor: {},
    } as unknown as Database;
    const state = loadHonkerOrFallback(fakeDb, {
      env: { ATMUX_HONKER: "on", HOME: "/Users/dev" },
      platform: "darwin",
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/setCustomSQLite not available/);
  });

  test("real defaultSmokeProbe — SELECT honker_version() throws when extension absent → fallback", () => {
    // Load hook stubbed (returns OK) but no smokeProbe hook → real
    // `SELECT honker_bootstrap()` fires against a DB without the
    // extension. The SQL throws "no such function: honker_bootstrap"
    // which the smoke probe catch wraps into a fallback. Exercises
    // the smoke-probe error path.
    const state = loadHonkerOrFallback(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {}, // pretend load succeeded
      // No smokeProbe hook — uses defaultSmokeProbe which runs real SQL
    });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toMatch(/smoke probe threw/);
    expect(state.fallbackReason).toMatch(/honker_bootstrap/);
  });
});

describe("bootHonker + getHonkerState", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
  });
  afterEach(() => {
    resetHonkerStateForTest(db);
    db.close();
  });

  test("getHonkerState returns null before bootHonker is called", () => {
    expect(getHonkerState(db)).toBeNull();
  });

  test("bootHonker stashes state retrievable via getHonkerState", () => {
    const state = bootHonker(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(state.loaded).toBe(true);
    expect(getHonkerState(db)).toBe(state);
  });

  test("second bootHonker call returns cached state (does not re-load)", () => {
    let loadCount = 0;
    bootHonker(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {
        loadCount += 1;
      },
      smokeProbe: () => true,
    });
    expect(loadCount).toBe(1);
    // Second call with a fresh hook set should NOT fire loadExtension again.
    bootHonker(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {
        loadCount += 1;
      },
      smokeProbe: () => true,
    });
    expect(loadCount).toBe(1);
  });

  test("kill-switch off → state cached as {loaded: false} with no fallback reason", () => {
    const state = bootHonker(db, { env: { ATMUX_HONKER: "off" } });
    expect(state.loaded).toBe(false);
    expect(state.fallbackReason).toBeNull();
    expect(getHonkerState(db)).toBe(state);
  });

  test("announce callback invoked with the final state", () => {
    const announced: Array<{ loaded: boolean; reason: string | null }> = [];
    bootHonker(
      db,
      {
        env: { ATMUX_HONKER: "on", HOME: "/root" },
        platform: "linux",
        loadExtension: () => {
          throw new Error("missing binary");
        },
      },
      (_db, state) => {
        announced.push({ loaded: state.loaded, reason: state.fallbackReason });
      },
    );
    expect(announced).toHaveLength(1);
    expect(announced[0]?.loaded).toBe(false);
    expect(announced[0]?.reason).toMatch(/missing binary/);
  });

  test("announce callback throwing does NOT block boot (best-effort observability)", () => {
    const state = bootHonker(
      db,
      {
        env: { ATMUX_HONKER: "on", HOME: "/root" },
        platform: "linux",
        loadExtension: () => {},
        smokeProbe: () => true,
      },
      () => {
        throw new Error("emit failed");
      },
    );
    expect(state.loaded).toBe(true);
    expect(getHonkerState(db)).toBe(state);
  });

  test("resetHonkerStateForTest clears the cache (test-only)", () => {
    bootHonker(db, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(getHonkerState(db)).not.toBeNull();
    resetHonkerStateForTest(db);
    expect(getHonkerState(db)).toBeNull();
  });
});
