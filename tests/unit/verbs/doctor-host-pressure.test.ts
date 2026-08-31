// Unit tests for the host-pressure doctor probe (ADR-184 §Amendment
// 2026-05-21):
//   - hostPressureRows() — pure mapping from HostPressureVerdict → DoctorRow[]
//   - checkHostPressure() — wrapper that calls the live probe + maps rows
//
// Sibling to tests/unit/verbs/doctor.test.ts — kept separate per the
// doctor-honker.test.ts precedent.

import { describe, expect, test } from "bun:test";
import type { HostPressureVerdict } from "../../../src/core/host-pressure.ts";
import { checkHostPressure, hostPressureRows } from "../../../src/verbs/doctor.ts";

describe("hostPressureRows (pure)", () => {
  test("non-Linux skipped verdict → info row", () => {
    const v: HostPressureVerdict = {
      ok: true,
      reasons: [],
      probe: null,
      thresholds: null,
      skipped: true,
    };
    const rows = hostPressureRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.label).toBe("host-pressure");
    expect(rows[0]?.detail).toMatch(/non-Linux/);
  });

  test("probe data unavailable → info (defensive — should not normally hit)", () => {
    const v: HostPressureVerdict = {
      ok: true,
      reasons: [],
      probe: null,
      thresholds: null,
      skipped: false,
    };
    const rows = hostPressureRows(v);
    expect(rows[0]?.status).toBe("info");
    expect(rows[0]?.detail).toMatch(/probe data unavailable/);
  });

  test("ok verdict → green with load/mem/cores detail", () => {
    const v: HostPressureVerdict = {
      ok: true,
      reasons: [],
      probe: {
        loadAvg1min: 2.5,
        loadAvg15min: 3.2,
        memAvailableMb: 32000,
        cpuCores: 16,
        memTotalMb: 65536,
        disks: [],
        missingMounts: [],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    };
    const rows = hostPressureRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toContain("under threshold");
    expect(rows[0]?.detail).toContain("load 15min 3.20");
    expect(rows[0]?.detail).toContain("12.00 ceil"); // 16 × 0.75
    expect(rows[0]?.detail).toContain("mem 32000MB");
    expect(rows[0]?.detail).toContain("8192MB floor");
    expect(rows[0]?.detail).toContain("16 cores");
  });

  test("over-threshold verdict → yellow with reasons + actionable hint", () => {
    const v: HostPressureVerdict = {
      ok: false,
      reasons: ["load 15min 22.12 > 12.00 (16 cores × 0.75)"],
      probe: {
        loadAvg1min: 8.5,
        loadAvg15min: 22.12,
        memAvailableMb: 30000,
        cpuCores: 16,
        memTotalMb: 65536,
        disks: [],
        missingMounts: [],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    };
    const rows = hostPressureRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.detail).toContain("OVER threshold");
    expect(rows[0]?.hint).toContain("load 15min 22.12");
    expect(rows[0]?.hint).toContain("REFUSE");
    expect(rows[0]?.hint).toContain("--force-spawn");
    expect(rows[0]?.hint).toContain("ATMUX_SPAWN_MAX_LOAD_RATIO");
  });

  test("over-threshold verdict renders non-empty disk usage and missing mounts", () => {
    const v: HostPressureVerdict = {
      ok: false,
      reasons: ["disk / 91% > 90% threshold"],
      probe: {
        loadAvg1min: 8.5,
        loadAvg15min: 22.12,
        memAvailableMb: 2048,
        cpuCores: 16,
        memTotalMb: 65536,
        disks: [
          { mount: "/", totalMb: 100000, availableMb: 9000, usedPercent: 91 },
          { mount: "/var", totalMb: 50000, availableMb: 6000, usedPercent: 88 },
        ],
        missingMounts: ["/home"],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    };
    const rows = hostPressureRows(v);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.label).toBe("host-pressure");
    expect(rows[0]?.detail).toContain("disk / 91%/90%, /var 88%/90%, /home NOT REPORTED");
    expect(rows[0]?.detail).not.toContain("none reported");
    expect(rows[0]?.detail).toContain("OVER threshold");
    expect(rows[0]?.hint).toContain("REFUSE");
  });

  test("multiple reasons surface in the hint", () => {
    const v: HostPressureVerdict = {
      ok: false,
      reasons: [
        "load 15min 22.12 > 12.00 (16 cores × 0.75)",
        "MemAvailable 2048MB < 8192MB threshold",
      ],
      probe: {
        loadAvg1min: 10,
        loadAvg15min: 22.12,
        memAvailableMb: 2048,
        cpuCores: 16,
        memTotalMb: 65536,
        disks: [],
        missingMounts: [],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    };
    const rows = hostPressureRows(v);
    expect(rows[0]?.status).toBe("yellow");
    expect(rows[0]?.hint).toContain("load 15min");
    expect(rows[0]?.hint).toContain("MemAvailable");
  });
});

describe("checkHostPressure (verb-side wrapper)", () => {
  test("delegates to injected probe + maps result", async () => {
    let probeCalled = false;
    const rows = await checkHostPressure(async () => {
      probeCalled = true;
      return {
        ok: true,
        reasons: [],
        probe: {
          loadAvg1min: 1.0,
          loadAvg15min: 1.5,
          memAvailableMb: 24000,
          cpuCores: 8,
          memTotalMb: 65536,
          disks: [],
          missingMounts: [],
        },
        thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
        skipped: false,
      };
    });
    expect(probeCalled).toBe(true);
    expect(rows[0]?.status).toBe("green");
    expect(rows[0]?.detail).toContain("8 cores");
  });

  test("propagates yellow verdict through the wrapper", async () => {
    const rows = await checkHostPressure(async () => ({
      ok: false,
      reasons: ["MemAvailable 4096MB < 8192MB threshold"],
      probe: {
        loadAvg1min: 1,
        loadAvg15min: 1,
        memAvailableMb: 4096,
        cpuCores: 8,
        memTotalMb: 65536,
        disks: [],
        missingMounts: [],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    }));
    expect(rows[0]?.status).toBe("yellow");
  });

  test("default probeFn uses real probeHostPressure (smoke)", async () => {
    // No injection — exercises the default-arg branch. On Linux this
    // hits real /proc; on macOS it returns skipped. Either way, the
    // function completes without throwing.
    const rows = await checkHostPressure();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("host-pressure");
    // status is one of green/yellow/info depending on host state
    const status = rows[0]?.status ?? "<undefined>";
    expect(["green", "yellow", "info"]).toContain(status);
  });
});
