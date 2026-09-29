// ADR-239 — unit tests for src/core/drivers.ts.
//
// Pure-fn coverage for resolveDriversList (drivers[] precedence + canonical
// three-driver fallback; the legacy driverSession/driverTui synthesis was
// removed per ADR-266 §D2), resolveDriverCwd, canonicalDriverName and trunk identity.

import { describe, expect, test } from "bun:test";
import {
  CANONICAL_DRIVER_PAIR_PRESET,
  CANONICAL_PARENT_TEAM_DRIVERS,
  canonicalDriverName,
  type DriverSession,
  isDriverPairMaterialized,
  isTrunkDriver,
  resolveDriverCwd,
  resolveDriverPair,
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

  test("drivers[] empty → canonical three-driver roster", () => {
    expect(resolveDriversList({ drivers: [] })).toEqual([...CANONICAL_PARENT_TEAM_DRIVERS]);
  });

  test("no drivers[] → canonical three-driver roster", () => {
    expect(resolveDriversList({})).toEqual([...CANONICAL_PARENT_TEAM_DRIVERS]);
  });

  test("fallback returns fresh copies; mutating them leaves the canonical roster intact", () => {
    const first = resolveDriversList({});
    (first[0] as { cwd: string }).cwd = "/mutated";
    first.push({ name: "driver-4", tui: null, cwd: "." });
    expect(resolveDriversList({})).toEqual([...CANONICAL_PARENT_TEAM_DRIVERS]);
    expect(CANONICAL_PARENT_TEAM_DRIVERS[0]?.cwd).toBe(".");
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

describe("resolveDriverPair — ADR-288 rollout gate", () => {
  test("absent driverPair → fresh canonical preset with materialize falsy", () => {
    const resolved = resolveDriverPair({});
    expect(resolved).toEqual(CANONICAL_DRIVER_PAIR_PRESET);
    expect(resolved).not.toBe(CANONICAL_DRIVER_PAIR_PRESET);
    expect(resolved.panes).not.toBe(CANONICAL_DRIVER_PAIR_PRESET.panes);
    expect(isDriverPairMaterialized({})).toBe(false);
  });

  test("null driverPair → canonical preset, gate off", () => {
    expect(resolveDriverPair({ driverPair: null }).materialize).toBe(false);
    expect(isDriverPairMaterialized({ driverPair: null })).toBe(false);
  });

  test("explicit materialize:true passes through and opens the gate", () => {
    const preset = { ...resolveDriverPair({}), materialize: true as const };
    expect(resolveDriverPair({ driverPair: preset })).toBe(preset);
    expect(isDriverPairMaterialized({ driverPair: preset })).toBe(true);
  });

  test("explicit driverPair without materialize → gate off", () => {
    const { materialize: _dropped, ...rest } = CANONICAL_DRIVER_PAIR_PRESET;
    expect(isDriverPairMaterialized({ driverPair: rest })).toBe(false);
  });
});
