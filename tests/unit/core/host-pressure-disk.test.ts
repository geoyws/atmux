// Unit tests for the DISK dimension of src/core/host-pressure.ts
// (ADR-273 §Supplement).
//
// Split from host-pressure.test.ts because it is a distinct dimension
// with its own parser, its own threshold and its own failure mode — the
// missing mount, which is the one case where "df said nothing" must
// read as UNKNOWN rather than as headroom.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MOUNTS,
  parseDfOutput,
  parseMemAvailableMb,
  parseMemTotalMb,
  probeHostPressure,
  resolveThresholds,
} from "../../../src/core/host-pressure.ts";

/** A real `df -P -k /` payload from hax — 458 GB root at 47%. */
const DF_HEALTHY =
  "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
  "/dev/md2         457717264 213000000 244717264      47% /\n";

describe("parseDfOutput", () => {
  test("reads a real `df -P -k /` payload field for field", () => {
    const s = parseDfOutput(DF_HEALTHY, ["/"]);
    expect(s.missingMounts).toEqual([]);
    expect(s.disks).toHaveLength(1);
    expect(s.disks[0]?.mount).toBe("/");
    // 457717264 KB / 1024 = 446989 MB; 244717264 KB / 1024 = 238981 MB.
    expect(s.disks[0]?.totalMb).toBe(446989);
    expect(s.disks[0]?.availableMb).toBe(238981);
    // df's own Capacity column, so this tool and `df -h` agree.
    expect(s.disks[0]?.usedPercent).toBe(47);
  });

  test("the header line is not read as a filesystem row", () => {
    expect(parseDfOutput(DF_HEALTHY, ["/"]).disks.map((d) => d.mount)).toEqual(["/"]);
  });

  test("multiple mounts each get a row", () => {
    const text =
      "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
      "/dev/md2         457717264 213000000 244717264      47% /\n" +
      "/dev/md3        1048576000 943718400 104857600      90% /data\n";
    const s = parseDfOutput(text, ["/", "/data"]);
    expect(s.disks).toHaveLength(2);
    expect(s.disks[1]?.mount).toBe("/data");
    expect(s.disks[1]?.usedPercent).toBe(90);
    expect(s.missingMounts).toEqual([]);
  });

  test("a duplicate row for one mount is counted ONCE", () => {
    // `df -P -k / /root` prints the same row twice when both paths live
    // on one filesystem; double-counting would double its weight.
    const dup = "/dev/md2         457717264 213000000 244717264      47% /\n";
    const s = parseDfOutput(DF_HEALTHY + dup, ["/"]);
    expect(s.disks).toHaveLength(1);
  });

  test("a requested mount df did NOT report is named as missing", () => {
    const s = parseDfOutput(DF_HEALTHY, ["/", "/nope"]);
    expect(s.disks).toHaveLength(1);
    expect(s.missingMounts).toEqual(["/nope"]);
  });

  test("matching is EXACT on the mount point, so `/` cannot swallow a missing mount", () => {
    // The bug this pins, caught by the test below it before it shipped:
    // an ancestor-prefix rule makes `/` cover every absolute path, so a
    // genuinely absent `/data` would report as covered whenever `/` was
    // also probed — which is the DEFAULT configuration. The detection
    // would have been dead on arrival.
    const s = parseDfOutput(DF_HEALTHY, ["/", "/data"]);
    expect(s.missingMounts).toEqual(["/data"]);
  });

  test("a path that is not itself a mount point is reported missing", () => {
    // `/root` lives on `/`, but it is not a mount point and df labels no
    // row with it. `mounts` are mount POINTS by contract, so naming this
    // is a configuration error surfacing, not a false alarm.
    expect(parseDfOutput(DF_HEALTHY, ["/root"]).missingMounts).toEqual(["/root"]);
  });

  test("a nested mount matches its own row exactly", () => {
    const text =
      "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
      "/dev/md3        1048576000 943718400 104857600      90% /data\n";
    const s = parseDfOutput(text, ["/data"]);
    expect(s.missingMounts).toEqual([]);
    expect(s.disks[0]?.mount).toBe("/data");
  });

  test("empty df output leaves EVERY requested mount missing", () => {
    const s = parseDfOutput("", ["/", "/data"]);
    expect(s.disks).toEqual([]);
    expect(s.missingMounts).toEqual(["/", "/data"]);
  });

  test("df's stderr noise mixed in is ignored, not parsed as a row", () => {
    const text = `df: /nope: No such file or directory\n${DF_HEALTHY}`;
    const s = parseDfOutput(text, ["/", "/nope"]);
    expect(s.disks).toHaveLength(1);
    expect(s.missingMounts).toEqual(["/nope"]);
  });

  test("a mount point containing a space is read whole", () => {
    const text =
      "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
      "/dev/sdb1        104857600  52428800  52428800      50% /mnt/big disk\n";
    expect(parseDfOutput(text, ["/mnt/big disk"]).disks[0]?.mount).toBe("/mnt/big disk");
  });
});

describe("parseMemTotalMb", () => {
  test("reads MemTotal", () => {
    expect(parseMemTotalMb("MemTotal:       67108864 kB\nMemAvailable: 100 kB\n")).toBe(65536);
  });

  test("a missing MemTotal line throws rather than defaulting to 0", () => {
    // A zero total would make every memory percentage divide by nothing.
    expect(() => parseMemTotalMb("MemAvailable: 8388608 kB\n")).toThrow(/MemTotal line absent/);
  });

  test("MemAvailable and MemTotal are not confused with each other", () => {
    const info = "MemTotal:       67108864 kB\nMemAvailable:    2097152 kB\n";
    expect(parseMemTotalMb(info)).toBe(65536);
    expect(parseMemAvailableMb(info)).toBe(2048);
  });
});

describe("resolveThresholds — disk", () => {
  test("defaults to 90%, the same line the hig sentinel alerts on", () => {
    expect(resolveThresholds({}).maxDiskPercent).toBe(90);
  });

  test("honours a valid ATMUX_SPAWN_MAX_DISK_PERCENT", () => {
    expect(resolveThresholds({ ATMUX_SPAWN_MAX_DISK_PERCENT: "80" }).maxDiskPercent).toBe(80);
  });

  test.each([["abc"], [""], ["0"], ["-5"], ["101"]])("fails CLOSED to 90 on %p", (raw) => {
    expect(resolveThresholds({ ATMUX_SPAWN_MAX_DISK_PERCENT: raw }).maxDiskPercent).toBe(90);
  });
});

describe("probeHostPressure — disk participates in the verdict", () => {
  const base = {
    readLoadAvg: async () => "1.00 1.00 1.00 1/100 1\n",
    readMemInfo: async () => "MemTotal: 67108864 kB\nMemAvailable: 33554432 kB\n",
    readCpuCount: async () => 16,
    platform: "linux",
    env: {} as NodeJS.ProcessEnv,
  };

  test("a healthy disk leaves the verdict ok, and the reading is carried", async () => {
    const v = await probeHostPressure({ ...base, readDf: async () => DF_HEALTHY });
    expect(v.ok).toBe(true);
    expect(v.probe?.disks[0]?.usedPercent).toBe(47);
    expect(v.probe?.memTotalMb).toBe(65536);
  });

  test("a disk over the ceiling makes the verdict NOT ok", async () => {
    // Load and memory are calm here, so if this ever returns ok the disk
    // dimension has been measured and then ignored — the exact failure
    // the §Supplement exists to prevent.
    const full =
      "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
      "/dev/md2         457717264 448562919   9154345      99% /\n";
    const v = await probeHostPressure({ ...base, readDf: async () => full });
    expect(v.ok).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain("disk / 99% full > 90% threshold");
    expect(v.reasons[0]).toContain("8939MB free");
  });

  test("a disk exactly AT the threshold is not over it", async () => {
    const at90 =
      "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
      "/dev/md2         457717264 411945538  45771726      90% /\n";
    expect((await probeHostPressure({ ...base, readDf: async () => at90 })).ok).toBe(true);
  });

  test("a missing mount makes the verdict NOT ok", async () => {
    const v = await probeHostPressure({
      ...base,
      mounts: ["/data"],
      readDf: async () => "Filesystem     1024-blocks      Used Available Capacity Mounted on\n",
    });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("disk /data not reported by df");
    expect(v.reasons[0]).toContain("not assumed free");
  });

  test("the df reader is asked for the resolved mount list", async () => {
    const asked: string[][] = [];
    await probeHostPressure({
      ...base,
      readDf: async (mounts) => {
        asked.push([...mounts]);
        return DF_HEALTHY;
      },
    });
    expect(asked).toEqual([[...DEFAULT_MOUNTS]]);
  });

  test("an explicit mount list overrides the default", async () => {
    const asked: string[][] = [];
    await probeHostPressure({
      ...base,
      mounts: ["/", "/data"],
      readDf: async (mounts) => {
        asked.push([...mounts]);
        return DF_HEALTHY;
      },
    });
    expect(asked).toEqual([["/", "/data"]]);
  });

  test("the disk ceiling is env-tunable and takes effect", async () => {
    const v = await probeHostPressure({
      ...base,
      env: { ATMUX_SPAWN_MAX_DISK_PERCENT: "40" },
      readDf: async () => DF_HEALTHY,
    });
    // 47% passes at the default 90 and fails at a tuned 40.
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toContain("47% full > 40% threshold");
  });

  test("a df that THROWS does not throw the whole probe — it gates instead", async () => {
    // `probeHostPressure` is awaited without a try/catch on spawn-epic's
    // hot path, so letting the one subprocess dimension throw would turn
    // a measurement problem into a hard refusal to spawn anything.
    // A rejection here fails the test outright, which IS the
    // "does not throw the whole probe" assertion — no wrapper needed.
    const v = await probeHostPressure({
      ...base,
      readDf: async () => {
        throw new Error("spawn timeout after 10000ms: df");
      },
    });
    // Soft, but NOT silent: unknown headroom still gates.
    expect(v.ok).toBe(false);
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain("disk unreadable — df failed");
    expect(v.reasons[0]).toContain("spawn timeout after 10000ms");
    expect(v.reasons[0]).toContain("not assumed free");
    // Load and memory were still read, so the rest of the report stands.
    expect(v.probe?.cpuCores).toBe(16);
    expect(v.probe?.memTotalMb).toBe(65536);
    expect(v.probe?.disks).toEqual([]);
  });

  test("a df failure names the cause ONCE, not once per requested mount", async () => {
    const v = await probeHostPressure({
      ...base,
      mounts: ["/", "/data", "/var"],
      readDf: async () => {
        throw new Error("df: command not found");
      },
    });
    expect(v.reasons).toHaveLength(1);
    expect(v.probe?.missingMounts).toEqual(["/", "/data", "/var"]);
  });

  test("a malformed /proc read still THROWS — only the subprocess is caught", async () => {
    // The soft-fail is scoped to `df`. A broken /proc is a different
    // class and must not be quietly absorbed.
    await expect(
      probeHostPressure({
        ...base,
        readMemInfo: async () => "nonsense",
        readDf: async () => DF_HEALTHY,
      }),
    ).rejects.toThrow(/MemAvailable line absent/);
  });

  test("a non-Linux platform skips the disk read entirely", async () => {
    let called = false;
    const v = await probeHostPressure({
      ...base,
      platform: "darwin",
      readDf: async () => {
        called = true;
        return DF_HEALTHY;
      },
    });
    expect(v.skipped).toBe(true);
    expect(called).toBe(false);
  });
});
