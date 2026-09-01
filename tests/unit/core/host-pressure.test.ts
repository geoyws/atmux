// Unit tests for src/core/host-pressure.ts (ADR-184 substrate).

import { describe, expect, test } from "bun:test";
// The DISK dimension has its own suite — tests/unit/core/host-pressure-disk.test.ts.
import {
  formatPressureError,
  type HostPressureVerdict,
  parseLoadAvg,
  parseMemAvailableMb,
  probeHostPressure,
  resolveThresholds,
} from "../../../src/core/host-pressure.ts";

/** A healthy `df -P -k /` payload — one 458 GB root at 47%. Injected
 *  so no unit test shells out to a real `df`. */
const DF_HEALTHY =
  "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
  "/dev/md2         457717264 213000000 244717264      47% /\n";

describe("resolveThresholds", () => {
  test("defaults when env empty", () => {
    const t = resolveThresholds({});
    expect(t.maxLoadRatio).toBe(0.75);
    expect(t.minMemMb).toBe(8192);
  });

  test("ATMUX_SPAWN_MAX_LOAD_RATIO honored", () => {
    expect(resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "1.5" }).maxLoadRatio).toBe(1.5);
    expect(resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "0.5" }).maxLoadRatio).toBe(0.5);
  });

  test("ATMUX_SPAWN_MIN_FREE_MB honored", () => {
    expect(resolveThresholds({ ATMUX_SPAWN_MIN_FREE_MB: "4096" }).minMemMb).toBe(4096);
    expect(resolveThresholds({ ATMUX_SPAWN_MIN_FREE_MB: "0" }).minMemMb).toBe(0);
  });

  test("invalid env falls back to default", () => {
    const t1 = resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "garbage" });
    expect(t1.maxLoadRatio).toBe(0.75);

    const t2 = resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "-1" });
    expect(t2.maxLoadRatio).toBe(0.75);

    const t3 = resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "999" });
    expect(t3.maxLoadRatio).toBe(0.75);

    const t4 = resolveThresholds({ ATMUX_SPAWN_MIN_FREE_MB: "garbage" });
    expect(t4.minMemMb).toBe(8192);

    const t5 = resolveThresholds({ ATMUX_SPAWN_MIN_FREE_MB: "-100" });
    expect(t5.minMemMb).toBe(8192);
  });

  test("whitespace trimmed", () => {
    expect(resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "  0.5  " }).maxLoadRatio).toBe(0.5);
    expect(resolveThresholds({ ATMUX_SPAWN_MIN_FREE_MB: "  4096  " }).minMemMb).toBe(4096);
  });

  test("empty string falls back to default", () => {
    expect(resolveThresholds({ ATMUX_SPAWN_MAX_LOAD_RATIO: "" }).maxLoadRatio).toBe(0.75);
    expect(resolveThresholds({ ATMUX_SPAWN_MIN_FREE_MB: "" }).minMemMb).toBe(8192);
  });
});

describe("parseLoadAvg", () => {
  test("happy path", () => {
    const r = parseLoadAvg("1.23 4.56 7.89 1/234 56789");
    expect(r.l1).toBe(1.23);
    expect(r.l15).toBe(7.89);
  });

  test("zero values OK", () => {
    const r = parseLoadAvg("0.00 0.00 0.00 1/1 1");
    expect(r.l1).toBe(0);
    expect(r.l15).toBe(0);
  });

  test("trailing newline OK", () => {
    const r = parseLoadAvg("1.0 2.0 3.0 0/0 0\n");
    expect(r.l1).toBe(1);
    expect(r.l15).toBe(3);
  });

  test("malformed throws", () => {
    expect(() => parseLoadAvg("only-one-field")).toThrow(/malformed/);
    expect(() => parseLoadAvg("a b c d e")).toThrow(/invalid/);
    expect(() => parseLoadAvg("-1 -2 -3 0/0 0")).toThrow(/invalid/);
  });
});

describe("parseMemAvailableMb", () => {
  test("happy path — converts kB to MB", () => {
    const r = parseMemAvailableMb("MemTotal:    16000000 kB\nMemAvailable: 8388608 kB\n");
    expect(r).toBe(8192); // 8388608 / 1024 = 8192
  });

  test("zero", () => {
    const r = parseMemAvailableMb("MemAvailable:        0 kB\n");
    expect(r).toBe(0);
  });

  test("missing MemAvailable line throws", () => {
    expect(() => parseMemAvailableMb("MemTotal: 16000000 kB\n")).toThrow(
      /MemAvailable line absent/,
    );
  });

  test("invalid value throws", () => {
    expect(() => parseMemAvailableMb("MemAvailable: -100 kB\n")).toThrow(/absent/);
  });
});

describe("probeHostPressure", () => {
  test("skips on non-Linux", async () => {
    const v = await probeHostPressure({ platform: "darwin" });
    expect(v.ok).toBe(true);
    expect(v.skipped).toBe(true);
    expect(v.probe).toBeNull();
    expect(v.thresholds).toBeNull();
    expect(v.reasons).toEqual([]);
  });

  test("green when load + mem both pass", async () => {
    const v = await probeHostPressure({
      platform: "linux",
      readLoadAvg: async () => "0.5 0.5 0.5 1/100 1000",
      readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 16777216 kB\n", // 16GB
      readDf: async () => DF_HEALTHY,
      readCpuCount: async () => 16,
      env: {},
    });
    expect(v.ok).toBe(true);
    expect(v.skipped).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.probe?.cpuCores).toBe(16);
    expect(v.probe?.memAvailableMb).toBe(16384);
  });

  test("red on high load", async () => {
    const v = await probeHostPressure({
      platform: "linux",
      readLoadAvg: async () => "20.0 20.0 20.0 1/100 1000",
      readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 16777216 kB\n",
      readDf: async () => DF_HEALTHY,
      readCpuCount: async () => 16,
      env: {},
    });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toMatch(/load 15min 20\.00 > 12\.00 \(16 cores × 0\.75\)/);
  });

  test("red on low mem", async () => {
    const v = await probeHostPressure({
      platform: "linux",
      readLoadAvg: async () => "0.5 0.5 0.5 1/100 1000",
      readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 2097152 kB\n", // 2GB
      readDf: async () => DF_HEALTHY,
      readCpuCount: async () => 16,
      env: {},
    });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toMatch(/MemAvailable 2048MB < 8192MB threshold/);
  });

  test("red on BOTH thresholds", async () => {
    const v = await probeHostPressure({
      platform: "linux",
      readLoadAvg: async () => "20.0 20.0 20.0 1/100 1000",
      readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 2097152 kB\n",
      readDf: async () => DF_HEALTHY,
      readCpuCount: async () => 16,
      env: {},
    });
    expect(v.ok).toBe(false);
    expect(v.reasons).toHaveLength(2);
  });

  test("respects env-tuned thresholds", async () => {
    // Tighter threshold (0.3 ratio) → 16 × 0.3 = 4.8 ceiling. 5.0 load fails.
    const v = await probeHostPressure({
      platform: "linux",
      readLoadAvg: async () => "5.0 5.0 5.0 1/100 1000",
      readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 16777216 kB\n",
      readDf: async () => DF_HEALTHY,
      readCpuCount: async () => 16,
      env: { ATMUX_SPAWN_MAX_LOAD_RATIO: "0.3" },
    });
    expect(v.ok).toBe(false);

    // Looser threshold (2.0 ratio) — same load passes
    const v2 = await probeHostPressure({
      platform: "linux",
      readLoadAvg: async () => "5.0 5.0 5.0 1/100 1000",
      readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 16777216 kB\n",
      readDf: async () => DF_HEALTHY,
      readCpuCount: async () => 16,
      env: { ATMUX_SPAWN_MAX_LOAD_RATIO: "2.0" },
    });
    expect(v2.ok).toBe(true);
  });

  test("uses default readers when injectors not provided (platform=linux)", async () => {
    // This test confirms the default-readers branch is exercised.
    // On real Linux hosts (CI/dev), /proc files exist. On non-Linux,
    // the early-return path handles it.
    if (process.platform !== "linux") {
      // Defaults branch unreachable; skip but mark.
      expect(true).toBe(true);
      return;
    }
    // Just verify the function runs to completion against real /proc.
    const v = await probeHostPressure({});
    expect(v.skipped).toBe(false);
    expect(v.probe).not.toBeNull();
    expect(v.probe?.cpuCores).toBeGreaterThan(0);
  });
});

describe("formatPressureError", () => {
  test("empty when skipped", () => {
    const v: HostPressureVerdict = {
      ok: true,
      reasons: [],
      probe: null,
      thresholds: null,
      skipped: true,
    };
    expect(formatPressureError(v)).toBe("");
  });

  test("empty when ok", () => {
    const v: HostPressureVerdict = {
      ok: true,
      reasons: [],
      probe: {
        loadAvg1min: 0.5,
        loadAvg15min: 0.5,
        memAvailableMb: 16384,
        cpuCores: 16,
        memTotalMb: 65536,
        disks: [],
        missingMounts: [],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    };
    expect(formatPressureError(v)).toBe("");
  });

  test("multi-line reason render", () => {
    const v: HostPressureVerdict = {
      ok: false,
      reasons: ["load 15min 20.00 > 12.00", "MemAvailable 2048MB < 8192MB"],
      probe: {
        loadAvg1min: 20,
        loadAvg15min: 20,
        memAvailableMb: 2048,
        cpuCores: 16,
        memTotalMb: 65536,
        disks: [],
        missingMounts: [],
      },
      thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
      skipped: false,
    };
    const out = formatPressureError(v);
    expect(out).toContain("host under pressure");
    expect(out).toContain("load 15min");
    expect(out).toContain("MemAvailable");
  });
});
