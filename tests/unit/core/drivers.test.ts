// ADR-239 — unit tests for src/core/drivers.ts.
//
// Pure-fn coverage for resolveDriversList (drivers[] precedence + legacy
// synthesis + empty fallthrough), resolveDriverCwd (relative / absolute /
// "."), isDriverPaneName (driver / driver-N / non-driver), and
// canonicalDriverName (index → name).

import { describe, expect, test } from "bun:test";
import {
  canonicalDriverName,
  type DriverSession,
  isDriverPaneName,
  isTrunkDriver,
  resolveDriverCwd,
  resolveDriversList,
} from "../../../src/core/drivers.ts";

describe("resolveDriversList — ADR-239 §A1 + §D7 precedence", () => {
  test("drivers[] present + non-empty → returns as-is", () => {
    const drivers: DriverSession[] = [
      { name: "driver", tui: "claude", cwd: "." },
      { name: "driver-2", tui: "claude", cwd: ".atmux/worktrees/driver-2" },
    ];
    expect(resolveDriversList({ drivers })).toEqual(drivers);
  });

  test("drivers[] empty → falls through to legacy synthesis", () => {
    expect(resolveDriversList({ drivers: [], driverSession: { tui: "claude" } })).toEqual([
      { name: "driver", tui: "claude", cwd: "." },
    ]);
  });

  test("legacy driverSession.tui → single-element synthesis", () => {
    expect(resolveDriversList({ driverSession: { tui: "claude" } })).toEqual([
      { name: "driver", tui: "claude", cwd: "." },
    ]);
  });

  test("legacy driverSession.tui = cursor → synthesis carries the TUI", () => {
    expect(resolveDriversList({ driverSession: { tui: "cursor" } })).toEqual([
      { name: "driver", tui: "cursor", cwd: "." },
    ]);
  });

  test("legacy driverTui (no driverSession block) → single-element synthesis", () => {
    expect(resolveDriversList({ driverTui: "opencode" })).toEqual([
      { name: "driver", tui: "opencode", cwd: "." },
    ]);
  });

  test("driverSession present but .tui null → falls through to driverTui", () => {
    expect(
      resolveDriversList({ driverSession: { tui: null }, driverTui: "claude" }),
    ).toEqual([{ name: "driver", tui: "claude", cwd: "." }]);
  });

  test("driverSession = null + no driverTui → empty array", () => {
    expect(resolveDriversList({ driverSession: null })).toEqual([]);
  });

  test("neither drivers[] nor legacy fields → empty array", () => {
    expect(resolveDriversList({})).toEqual([]);
  });

  test("drivers[] takes precedence over legacy fields", () => {
    const drivers: DriverSession[] = [{ name: "driver", tui: "cursor", cwd: "." }];
    expect(
      resolveDriversList({ drivers, driverSession: { tui: "claude" }, driverTui: "opencode" }),
    ).toEqual(drivers);
  });
});

describe("resolveDriverCwd — relative / absolute / dot anchoring", () => {
  test('"." resolves to projectRoot', () => {
    expect(resolveDriverCwd({ name: "driver", tui: "claude", cwd: "." }, "/srv/atmux")).toBe(
      "/srv/atmux",
    );
  });

  test('"" resolves to projectRoot', () => {
    expect(resolveDriverCwd({ name: "driver", tui: "claude", cwd: "" }, "/srv/atmux")).toBe(
      "/srv/atmux",
    );
  });

  test("relative cwd anchors under projectRoot", () => {
    expect(
      resolveDriverCwd(
        { name: "driver-2", tui: "claude", cwd: ".atmux/worktrees/driver-2" },
        "/srv/atmux",
      ),
    ).toBe("/srv/atmux/.atmux/worktrees/driver-2");
  });

  test("absolute cwd passes through verbatim", () => {
    expect(
      resolveDriverCwd({ name: "driver-3", tui: "claude", cwd: "/opt/somewhere" }, "/srv/atmux"),
    ).toBe("/opt/somewhere");
  });
});

describe("isDriverPaneName — ADR-239 §D2 driver-pattern", () => {
  test('"driver" matches', () => {
    expect(isDriverPaneName("driver")).toBe(true);
  });

  test('"driver-2" / "driver-5" / "driver-99" match', () => {
    expect(isDriverPaneName("driver-2")).toBe(true);
    expect(isDriverPaneName("driver-5")).toBe(true);
    expect(isDriverPaneName("driver-99")).toBe(true);
  });

  test("non-driver names do NOT match", () => {
    for (const name of [
      "lead",
      "planner",
      "reviewer",
      "docs",
      "gitter",
      "ombudsman",
      "__orchd__",
      "driverless",
      "driver_old",
      "Driver",
      "DRIVER",
      "driver-",
      "driver-0",
      "driver-01",
      "",
    ]) {
      expect(isDriverPaneName(name)).toBe(false);
    }
  });
});

describe("canonicalDriverName — index → pane-name", () => {
  test("index 1 → 'driver' (singular, no suffix)", () => {
    expect(canonicalDriverName(1)).toBe("driver");
  });

  test("index N>=2 → 'driver-N'", () => {
    expect(canonicalDriverName(2)).toBe("driver-2");
    expect(canonicalDriverName(5)).toBe("driver-5");
    expect(canonicalDriverName(10)).toBe("driver-10");
  });

  test("index <= 0 or non-integer → throws RangeError", () => {
    expect(() => canonicalDriverName(0)).toThrow(RangeError);
    expect(() => canonicalDriverName(-1)).toThrow(RangeError);
    expect(() => canonicalDriverName(1.5)).toThrow(RangeError);
    expect(() => canonicalDriverName(Number.NaN)).toThrow(RangeError);
  });
});

describe("isTrunkDriver — driver-1 (original) identification", () => {
  test('"driver" is trunk', () => {
    expect(isTrunkDriver({ name: "driver", tui: "claude", cwd: "." })).toBe(true);
  });

  test('"driver-N" (N>=2) is NOT trunk', () => {
    expect(isTrunkDriver({ name: "driver-2", tui: "claude", cwd: "x" })).toBe(false);
    expect(isTrunkDriver({ name: "driver-5", tui: "claude", cwd: "x" })).toBe(false);
  });
});
