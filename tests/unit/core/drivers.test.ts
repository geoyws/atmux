// ADR-239 — unit tests for src/core/drivers.ts.
//
// Pure-fn coverage for resolveDriversList (drivers[] precedence + empty
// fallthrough; the legacy driverSession/driverTui synthesis was removed
// per ADR-266 §D2), resolveDriverCwd (relative / absolute /
// "."), isDriverPaneName (driver / driver-N / non-driver), and
// canonicalDriverName (index → name).

import { describe, expect, test } from "bun:test";
import {
  CANONICAL_DRIVER_PAIR_PRESET,
  CANONICAL_PARENT_TEAM_DRIVERS,
  canonicalDriverName,
  type DriverPairPaneSpec,
  DriverPairPresetSchema,
  type DriverSession,
  isDriverPaneName,
  isSupportedDriverCount,
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

  test("drivers[] empty → canonical three-driver default", () => {
    expect(resolveDriversList({ drivers: [] })).toEqual([...CANONICAL_PARENT_TEAM_DRIVERS]);
  });

  test("no drivers[] → canonical three-driver default", () => {
    expect(resolveDriversList({})).toEqual([...CANONICAL_PARENT_TEAM_DRIVERS]);
  });
});

describe("canonical driver contract constants", () => {
  test("three-driver floor and 10-driver ceiling are explicit", () => {
    expect(isSupportedDriverCount(3)).toBe(true);
    expect(isSupportedDriverCount(10)).toBe(true);
    expect(isSupportedDriverCount(2)).toBe(false);
    expect(isSupportedDriverCount(11)).toBe(false);
  });

  test("canonical pair preset is horizontal left/right with null-default attention launcher", () => {
    expect(CANONICAL_DRIVER_PAIR_PRESET).toEqual({
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          command: null,
        },
      ],
    });
    expect(DriverPairPresetSchema.parse(CANONICAL_DRIVER_PAIR_PRESET)).toEqual(
      CANONICAL_DRIVER_PAIR_PRESET,
    );
  });

  test("canonical pair preset runtime source is frozen against mutation", () => {
    expect(Object.isFrozen(CANONICAL_DRIVER_PAIR_PRESET)).toBe(true);
    expect(Object.isFrozen(CANONICAL_DRIVER_PAIR_PRESET.panes)).toBe(true);
    expect(Object.isFrozen(CANONICAL_DRIVER_PAIR_PRESET.panes[0])).toBe(true);
    expect(Object.isFrozen(CANONICAL_DRIVER_PAIR_PRESET.panes[1])).toBe(true);
    expect(() => {
      (CANONICAL_DRIVER_PAIR_PRESET.panes as unknown as DriverPairPaneSpec[])[0] = {
        role: "attention",
        side: "right",
        workflow: "kb-att",
        authority: "decision-only",
        command: null,
      };
    }).toThrow();
    expect(CANONICAL_DRIVER_PAIR_PRESET.panes[0]).toEqual({ role: "worker", side: "left" });
  });

  test("resolveDriverPair returns a fresh canonical preset when absent", () => {
    const resolved = resolveDriverPair({});
    expect(resolved).toEqual(CANONICAL_DRIVER_PAIR_PRESET);
    expect(resolved).not.toBe(CANONICAL_DRIVER_PAIR_PRESET);
    expect(resolved.panes).not.toBe(CANONICAL_DRIVER_PAIR_PRESET.panes);
    expect(resolved.panes[0]).not.toBe(CANONICAL_DRIVER_PAIR_PRESET.panes[0]);
    expect(resolved.panes[1]).not.toBe(CANONICAL_DRIVER_PAIR_PRESET.panes[1]);
    resolved.panes[1].command = "claude --print";
    expect(resolved.panes[1].command).toBe("claude --print");
    expect(CANONICAL_DRIVER_PAIR_PRESET.panes[1].command).toBeNull();
  });

  test("resolveDriverPair preserves an explicit stored preset", () => {
    const preset = DriverPairPresetSchema.parse({
      layout: "horizontal",
      panes: [
        { role: "worker", side: "left" },
        {
          role: "attention",
          side: "right",
          workflow: "kb-att",
          authority: "decision-only",
          command: "claude --print",
        },
      ],
    });

    expect(resolveDriverPair({ driverPair: preset })).toBe(preset);
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
