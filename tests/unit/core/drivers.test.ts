// ADR-239 — unit tests for src/core/drivers.ts.
//
// Pure-fn coverage for resolveDriversList (drivers[] precedence + empty
// fallthrough; the legacy driverSession/driverTui synthesis was removed
// per ADR-266 §D2), resolveDriverCwd, canonicalDriverName and trunk identity.

import { describe, expect, test } from "bun:test";
import {
  canonicalDriverName,
  type DriverSession,
  isTrunkDriver,
  resolveDriverCwd,
  resolveDriversList,
} from "../../../src/core/drivers.ts";

describe("resolveDriversList — ADR-239 §A1 (post ADR-266 §D2)", () => {
  test("drivers[] present + non-empty → returns as-is", () => {
    const drivers: DriverSession[] = [
      { name: "driver", tui: "claude", cwd: "." },
      { name: "driver-2", tui: "claude", cwd: ".atmux/worktrees/driver-2" },
    ];
    expect(resolveDriversList({ drivers })).toEqual(drivers);
  });

  test("drivers[] empty → empty array (no legacy synthesis post-ADR-266)", () => {
    expect(resolveDriversList({ drivers: [] })).toEqual([]);
  });

  test("no drivers[] → empty array (caller falls back to __home placeholder)", () => {
    expect(resolveDriversList({})).toEqual([]);
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
