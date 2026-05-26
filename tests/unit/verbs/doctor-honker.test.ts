// Unit tests for the Honker substrate doctor probe (ADR-202 §D11):
//   - honkerStateRows() — pure mapping from HonkerRuntimeState → DoctorRow[]
//   - checkHonker() — I/O wrapper that opens the team state.db, boots
//                     the substrate, and surfaces the runtime state row
//
// Sibling to tests/unit/verbs/doctor.test.ts — kept separate to leave
// doctor.test.ts focused on its existing ~1300-line probe set.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HonkerRuntimeState } from "../../../src/abstractions/honker.ts";
import { checkHonker, honkerStateRows } from "../../../src/verbs/doctor.ts";

describe("honkerStateRows (pure)", () => {
  test("null state → info row 'boot not invoked'", () => {
    const rows = honkerStateRows(null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.label).toBe("honker");
    expect(rows[0]?.detail).toMatch(/boot not invoked/);
  });

  test("loaded state → green row with extension path", () => {
    const state: HonkerRuntimeState = {
      loaded: true,
      fallbackReason: null,
      extensionPath: "/root/.atmux/extensions/honker.so",
    };
    const rows = honkerStateRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toMatch(/substrate loaded/);
    expect(rows[0]?.detail).toMatch(/honker\.so/);
  });

  test("loaded state with null extensionPath renders <unknown>", () => {
    const state: HonkerRuntimeState = {
      loaded: true,
      fallbackReason: null,
      extensionPath: null,
    };
    const rows = honkerStateRows(state);
    expect(rows[0]?.detail).toMatch(/<unknown>/);
  });

  test("kill-switch off (loaded=false, reason=null) → info row 'kill-switch off'", () => {
    const state: HonkerRuntimeState = {
      loaded: false,
      fallbackReason: null,
      extensionPath: null,
    };
    const rows = honkerStateRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.detail).toMatch(/kill-switch off/);
    expect(rows[0]?.detail).toMatch(/poll-mode/);
  });

  test("explicit fallback (loaded=false, reason set) → yellow row with reason + install hint", () => {
    const state: HonkerRuntimeState = {
      loaded: false,
      fallbackReason: "loadExtension(/root/.atmux/extensions/honker.so) failed: ENOENT",
      extensionPath: "/root/.atmux/extensions/honker.so",
    };
    const rows = honkerStateRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/fallback mode/);
    expect(rows[0]?.detail).toMatch(/ENOENT/);
    expect(rows[0]?.hint).toMatch(/install wizard/);
    expect(rows[0]?.hint).toMatch(/poll-mode/);
  });
});

describe("checkHonker (I/O wrapper)", () => {
  let scratch: string;
  let atmuxDir: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-doctor-honker-"));
    atmuxDir = join(scratch, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("state.db absent → info row '(first-run or atmux init not invoked)'", async () => {
    const rows = await checkHonker(atmuxDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.detail).toMatch(/state\.db absent/);
  });

  test("state.db present, kill-switch EXPLICITLY off → info 'kill-switch off' row", async () => {
    // Force-create state.db by opening + closing it once with the
    // canonical migration ladder.
    const { Database } = await import("bun:sqlite");
    const stateDb = join(atmuxDir, "state.db");
    const init = new Database(stateDb, { create: true });
    init.close();
    // ADR-202 §Amendment 2026-05-21 flipped default OFF → ON, so empty
    // env now means substrate-load attempt (and yellow fallback if
    // binary absent). To exercise the kill-switch-off info row, set
    // ATMUX_HONKER=off explicitly.
    const rows = await checkHonker(atmuxDir, { env: { ATMUX_HONKER: "off" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.detail).toMatch(/kill-switch off/);
  });

  test("state.db present, kill-switch on, load fails → yellow fallback row", async () => {
    const { Database } = await import("bun:sqlite");
    const stateDb = join(atmuxDir, "state.db");
    new Database(stateDb, { create: true }).close();
    const rows = await checkHonker(atmuxDir, {
      env: { ATMUX_HONKER: "on", HOME: "/root" },
      platform: "linux",
      loadExtension: () => {
        throw new Error("synthetic: missing binary");
      },
    });
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toMatch(/fallback mode/);
    expect(rows[0]?.detail).toMatch(/synthetic: missing binary/);
  });

  test("state.db present, kill-switch on, load + smoke succeed → green row", async () => {
    const { Database } = await import("bun:sqlite");
    const stateDb = join(atmuxDir, "state.db");
    new Database(stateDb, { create: true }).close();
    const rows = await checkHonker(atmuxDir, {
      env: { ATMUX_HONKER: "on", HOME: "/root", ATMUX_HONKER_PATH: "/test/honker.so" },
      platform: "linux",
      loadExtension: () => {},
      smokeProbe: () => true,
    });
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toMatch(/substrate loaded/);
    expect(rows[0]?.detail).toMatch(/\/test\/honker\.so/);
  });
});
