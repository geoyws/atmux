// Unit tests for src/core/vox/host-report.ts — ADR-273 §Supplement
// `host_pressure`.
//
// The load-bearing property, and the reason most of this file exists:
// an UNREACHABLE host is never reported as healthy, never dropped from
// the report, and never lets the overall verdict come back ok. Every
// other assertion here is about numbers being right; that one is about
// the report not lying when it knows nothing.
//
// Every external boundary is injected — the ssh runner, the /proc and
// df readers (through a `probeLocal` wrapper around the REAL
// `probeHostPressure`, so the actual parse + threshold path runs), and
// the clock. Nothing here shells out.

import { describe, expect, test } from "bun:test";
import {
  type HostPressureVerdict,
  probeHostPressure,
  type ProbeHostPressureDeps,
} from "../../../../src/core/host-pressure.ts";
import {
  buildSnapshotCommand,
  DEFAULT_HOST_PROBE_TIMEOUT_MS,
  DEFAULT_HOST_TARGETS,
  type HostReportEntry,
  type HostTarget,
  parseSnapshot,
  probeHosts,
  renderHostReport,
  resolveHostProbeTimeoutMs,
  SNAPSHOT_MARKERS,
  speakProbeError,
  speakSize,
  summarizeHostReport,
} from "../../../../src/core/vox/host-report.ts";

// ---------- Fixtures ----------

/** 16-core box, 15-min load 4.00 → 25% of cores. Well under the 0.75
 *  ratio ceiling of 12.00. */
const LOAD_CALM = "1.20 2.00 4.00 3/900 12345\n";
/** 15-min load 14.00 on 16 cores → over the 12.00 ceiling. */
const LOAD_HOT = "18.00 16.00 14.00 40/900 12345\n";

/** 64 GB total, 32 GB available → 50% used. */
const MEM_ROOMY = "MemTotal:       67108864 kB\nMemAvailable:   33554432 kB\n";
/** 64 GB total, 2 GB available → under the 8192 MB floor. */
const MEM_TIGHT = "MemTotal:       67108864 kB\nMemAvailable:    2097152 kB\n";

/** 458 GB root at 47%. */
const DF_ROOMY =
  "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
  "/dev/md2         457717264 213000000 244717264      47% /\n";
/** Same root at 96% — over the 90% ceiling. */
const DF_FULL =
  "Filesystem     1024-blocks      Used Available Capacity Mounted on\n" +
  "/dev/md2         457717264 439408572   8308692      96% /\n";
/** df printed a header and no rows — the missing-mount case. */
const DF_EMPTY = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n";

/** Build a remote payload in the exact shape `buildSnapshotCommand`
 *  produces, so the parser is tested against the format the command
 *  actually emits rather than against a convenient invention. */
function snapshotPayload(opts: {
  load?: string;
  mem?: string;
  cpu?: string;
  df?: string;
}): string {
  return [
    SNAPSHOT_MARKERS.load,
    (opts.load ?? LOAD_CALM).trimEnd(),
    SNAPSHOT_MARKERS.mem,
    (opts.mem ?? MEM_ROOMY).trimEnd(),
    SNAPSHOT_MARKERS.cpu,
    opts.cpu ?? "12",
    SNAPSHOT_MARKERS.df,
    (opts.df ?? DF_ROOMY).trimEnd(),
    "",
  ].join("\n");
}

const LOCAL: HostTarget = { name: "hax", kind: "local", mounts: ["/"] };
const REMOTE: HostTarget = { name: "hig", kind: "ssh", sshHost: "hig", mounts: ["/"] };

/** Wrap the REAL probe with fixture readers for the LOCAL host only.
 *  `...d` last means the remote branch's pre-fetched readers win, so one
 *  wrapper serves both branches without faking either verdict. */
function localFixture(opts: {
  load?: string;
  mem?: string;
  cpu?: number;
  df?: string;
}): (d: ProbeHostPressureDeps) => Promise<HostPressureVerdict> {
  return (d) =>
    probeHostPressure({
      readLoadAvg: async () => opts.load ?? LOAD_CALM,
      readMemInfo: async () => opts.mem ?? MEM_ROOMY,
      readCpuCount: async () => opts.cpu ?? 16,
      readDf: async () => opts.df ?? DF_ROOMY,
      platform: "linux",
      ...d,
    });
}

/** Env with no threshold overrides, so defaults (0.75 / 8192 / 90) apply
 *  regardless of what the developer running the suite has exported. */
const CLEAN_ENV: NodeJS.ProcessEnv = {};

function entryFor(entries: HostReportEntry[], host: string): HostReportEntry {
  const e = entries.find((x) => x.host === host);
  if (e === undefined) throw new Error(`no entry for ${host}`);
  return e;
}

// ---------- Snapshot command + parser ----------

describe("buildSnapshotCommand", () => {
  test("every marker is QUOTED — an unquoted '#' is a shell comment", () => {
    // This is the bug the first live hig run hit: `echo #atmux:loadavg`
    // printed nothing, the payload lost all four section headers, and
    // the host reported unreachable. Asserting only that the marker
    // TEXT appears in the command would pass either way, which is why
    // the quoting itself is what is pinned here.
    const cmd = buildSnapshotCommand(["/"]);
    for (const marker of Object.values(SNAPSHOT_MARKERS)) {
      expect(marker.startsWith("#"), "markers start with # by design").toBe(true);
      expect(cmd).toContain(`echo '${marker}'`);
      expect(cmd, `${marker} must never be echoed bare`).not.toContain(`echo ${marker}`);
    }
  });

  test("emits all four markers and only READ-ONLY commands", () => {
    const cmd = buildSnapshotCommand(["/"]);
    expect(cmd).toContain(SNAPSHOT_MARKERS.load);
    expect(cmd).toContain(SNAPSHOT_MARKERS.mem);
    expect(cmd).toContain(SNAPSHOT_MARKERS.cpu);
    expect(cmd).toContain(SNAPSHOT_MARKERS.df);
    expect(cmd).toContain("cat /proc/loadavg");
    expect(cmd).toContain("cat /proc/meminfo");
    expect(cmd).toContain("grep -c '^processor' /proc/cpuinfo");
    expect(cmd).toContain("df -P -k '/'");
    // The operator's rule for hig is read-only. A write verb appearing
    // here is the regression this pins, so name them explicitly.
    for (const forbidden of [">", "rm ", "install", "apt", "tee ", "dd ", "mkdir"]) {
      expect(cmd, `snapshot command must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("single-quotes each mount so a space in a path cannot split the argv", () => {
    expect(buildSnapshotCommand(["/mnt/big disk"])).toContain("df -P -k '/mnt/big disk'");
  });

  test("a quote in a mount name is escaped, not passed through", () => {
    const cmd = buildSnapshotCommand(["/mnt/it's"]);
    expect(cmd).toContain(`'/mnt/it'\\''s'`);
  });
});

describe("parseSnapshot", () => {
  test("splits a real-shaped payload into its four sections", () => {
    const s = parseSnapshot(snapshotPayload({}));
    expect(s.cpuCount).toBe(12);
    expect(s.loadavg.trim()).toBe("1.20 2.00 4.00 3/900 12345");
    expect(s.meminfo).toContain("MemAvailable:   33554432 kB");
    expect(s.df).toContain("/dev/md2");
  });

  test("a payload missing a section THROWS — a partial read is not a reading", () => {
    const truncated = [
      SNAPSHOT_MARKERS.load,
      LOAD_CALM.trimEnd(),
      SNAPSHOT_MARKERS.mem,
      MEM_ROOMY.trimEnd(),
      "",
    ].join("\n");
    expect(() => parseSnapshot(truncated)).toThrow(/missing section/);
  });

  test("empty output (ssh died before running anything) throws", () => {
    expect(() => parseSnapshot("")).toThrow(/missing section/);
  });

  test("a non-numeric cpu count throws rather than defaulting", () => {
    // A defaulted core count would silently make every load percentage
    // wrong; wrong-and-confident is the outcome this rejects.
    expect(() => parseSnapshot(snapshotPayload({ cpu: "grep: no such file" }))).toThrow(
      /cpu count invalid/,
    );
  });

  test("a zero cpu count throws (it would divide load by nothing)", () => {
    expect(() => parseSnapshot(snapshotPayload({ cpu: "0" }))).toThrow(/cpu count invalid/);
  });
});

// ---------- Timeout resolution ----------

describe("resolveHostProbeTimeoutMs", () => {
  test("default when unset", () => {
    expect(resolveHostProbeTimeoutMs({})).toBe(DEFAULT_HOST_PROBE_TIMEOUT_MS);
  });

  test("honours a valid override", () => {
    expect(resolveHostProbeTimeoutMs({ ATMUX_HOST_PROBE_TIMEOUT_MS: "2500" })).toBe(2500);
  });

  test.each([["nope"], [""], ["0"], ["-5"], ["Infinity"], ["NaN"]])(
    "fails CLOSED to the default on %p",
    (raw) => {
      expect(resolveHostProbeTimeoutMs({ ATMUX_HOST_PROBE_TIMEOUT_MS: raw })).toBe(
        DEFAULT_HOST_PROBE_TIMEOUT_MS,
      );
    },
  );
});

// ---------- Both hosts healthy ----------

describe("probeHosts — both hosts healthy", () => {
  test("reads BOTH hosts, and each verdict carries that host's own numbers", async () => {
    const entries = await probeHosts({
      targets: [LOCAL, REMOTE],
      probeLocal: localFixture({}),
      runSsh: async () => snapshotPayload({}),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    expect(entries).toHaveLength(2);

    const hax = entryFor(entries, "hax");
    expect(hax.reachable).toBe(true);
    expect(hax.error).toBeNull();
    expect(hax.verdict?.ok).toBe(true);
    // 16 cores locally — from the injected /proc/cpuinfo count, not assumed.
    expect(hax.verdict?.probe?.cpuCores).toBe(16);
    expect(hax.verdict?.probe?.memTotalMb).toBe(65536);
    expect(hax.verdict?.probe?.memAvailableMb).toBe(32768);
    expect(hax.verdict?.probe?.disks[0]?.usedPercent).toBe(47);

    const hig = entryFor(entries, "hig");
    expect(hig.reachable).toBe(true);
    expect(hig.verdict?.ok).toBe(true);
    // 12 cores remotely — proving the remote count came off the wire and
    // was not inherited from the local box.
    expect(hig.verdict?.probe?.cpuCores).toBe(12);
  });

  test("the remote probe runs the built command against the configured sshHost", async () => {
    const calls: Array<{ host: string; command: string; timeoutMs: number }> = [];
    await probeHosts({
      targets: [REMOTE],
      runSsh: async (host, command, timeoutMs) => {
        calls.push({ host, command, timeoutMs });
        return snapshotPayload({});
      },
      env: CLEAN_ENV,
      timeoutMs: 4321,
      clock: () => 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe("hig");
    expect(calls[0]?.command).toBe(buildSnapshotCommand(["/"]));
    expect(calls[0]?.timeoutMs).toBe(4321);
  });

  test("renderHostReport says all healthy, and names both hosts", () => {
    const entries: HostReportEntry[] = [
      { host: "hax", reachable: true, verdict: okVerdict(16, 47), error: null, ms: 3 },
      { host: "hig", reachable: true, verdict: okVerdict(12, 72), error: null, ms: 90 },
    ];
    const out = renderHostReport(entries);
    expect(out).toContain("HOSTS: all 2 healthy.");
    expect(out).toContain("hax — HEALTHY");
    expect(out).toContain("hig — HEALTHY");
    expect(out).not.toContain("UNREACHABLE");
  });
});

/** A minimal probe for renderer-only tests. Split out from
 *  {@link okVerdict} so tests can widen it without a `!` on a nullable
 *  `verdict.probe`. */
function okProbe(cores: number, diskPct: number): NonNullable<HostPressureVerdict["probe"]> {
  return {
    loadAvg1min: cores / 4,
    loadAvg15min: cores / 4,
    memAvailableMb: 32768,
    memTotalMb: 65536,
    cpuCores: cores,
    disks: [{ mount: "/", totalMb: 447000, availableMb: 100000, usedPercent: diskPct }],
    missingMounts: [],
  };
}

/** A minimal ok verdict for renderer-only tests. */
function okVerdict(cores: number, diskPct: number): HostPressureVerdict {
  return {
    ok: true,
    reasons: [],
    probe: okProbe(cores, diskPct),
    thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
    skipped: false,
  };
}

// ---------- Each dimension individually over threshold ----------

describe("probeHosts — one dimension at a time over threshold", () => {
  test("CPU alone: load over the core-normalised ceiling, memory and disk fine", async () => {
    const entries = await probeHosts({
      targets: [LOCAL],
      probeLocal: localFixture({ load: LOAD_HOT }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const v = entryFor(entries, "hax").verdict;
    expect(v?.ok).toBe(false);
    expect(v?.reasons).toHaveLength(1);
    expect(v?.reasons[0]).toContain("load 15min 14.00");
    expect(v?.reasons[0]).toContain("12.00");
    // Reachable, and still measured — pressure is not unreachability.
    expect(entryFor(entries, "hax").reachable).toBe(true);
  });

  test("memory alone: MemAvailable under the floor, load and disk fine", async () => {
    const entries = await probeHosts({
      targets: [LOCAL],
      probeLocal: localFixture({ mem: MEM_TIGHT }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const v = entryFor(entries, "hax").verdict;
    expect(v?.ok).toBe(false);
    expect(v?.reasons).toHaveLength(1);
    expect(v?.reasons[0]).toBe("MemAvailable 2048MB < 8192MB threshold");
  });

  test("disk alone: 96% full trips it while load and memory are calm", async () => {
    const entries = await probeHosts({
      targets: [LOCAL],
      probeLocal: localFixture({ df: DF_FULL }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const v = entryFor(entries, "hax").verdict;
    expect(v?.ok).toBe(false);
    expect(v?.reasons).toHaveLength(1);
    expect(v?.reasons[0]).toContain("disk / 96% full > 90% threshold");
  });

  test("a missing mount is a REASON, not a pass", async () => {
    const entries = await probeHosts({
      targets: [{ name: "hax", kind: "local", mounts: ["/data"] }],
      probeLocal: localFixture({ df: DF_EMPTY }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const v = entryFor(entries, "hax").verdict;
    // If this ever goes green, the probe is calling a mount it could not
    // see "fine" — the exact failure class this module rejects.
    expect(v?.ok).toBe(false);
    expect(v?.reasons[0]).toContain("/data not reported by df");
    expect(v?.reasons[0]).toContain("not assumed free");
    expect(v?.probe?.missingMounts).toEqual(["/data"]);
  });

  test("all three at once produce three distinct reasons", async () => {
    const entries = await probeHosts({
      targets: [LOCAL],
      probeLocal: localFixture({ load: LOAD_HOT, mem: MEM_TIGHT, df: DF_FULL }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const v = entryFor(entries, "hax").verdict;
    expect(v?.ok).toBe(false);
    expect(v?.reasons).toHaveLength(3);
  });
});

// ---------- Unreachable ----------

describe("probeHosts — hig unreachable is UNREACHABLE, never healthy", () => {
  test("ssh rejects: hig is reported unreachable WITH the reason, hax still reported", async () => {
    const entries = await probeHosts({
      targets: [LOCAL, REMOTE],
      probeLocal: localFixture({}),
      runSsh: async () => {
        throw new Error("ssh: connect to host hig port 22: Connection refused");
      },
      env: CLEAN_ENV,
      clock: () => 0,
    });
    // Both hosts still appear — an unreachable host is never dropped.
    expect(entries.map((e) => e.host)).toEqual(["hax", "hig"]);
    const hig = entryFor(entries, "hig");
    expect(hig.reachable).toBe(false);
    expect(hig.verdict).toBeNull();
    expect(hig.error).toContain("Connection refused");
    // And the healthy host is unaffected.
    expect(entryFor(entries, "hax").verdict?.ok).toBe(true);
  });

  test("a slow host that times out reports unreachable, not healthy", async () => {
    const entries = await probeHosts({
      targets: [REMOTE],
      runSsh: async (_h, _c, timeoutMs) => {
        // What `spawn()` throws when its own deadline fires.
        throw new Error(`spawn timeout after ${timeoutMs}ms: ssh`);
      },
      env: CLEAN_ENV,
      timeoutMs: 15_000,
      clock: () => 0,
    });
    const hig = entryFor(entries, "hig");
    expect(hig.reachable).toBe(false);
    expect(hig.verdict).toBeNull();
    expect(hig.error).toContain("timeout after 15000ms");
  });

  test("a host that answers with GARBAGE is unreachable, not silently healthy", async () => {
    // ssh succeeded but the payload is unusable — e.g. a login banner
    // ate the output. Nothing was measured, so nothing may be claimed.
    const entries = await probeHosts({
      targets: [REMOTE],
      runSsh: async () => "Welcome to Ubuntu 24.04 LTS\nLast login: Sun\n",
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const hig = entryFor(entries, "hig");
    expect(hig.reachable).toBe(false);
    expect(hig.verdict).toBeNull();
    expect(hig.error).toContain("missing section");
  });

  test("malformed /proc inside an OTHERWISE well-formed payload is unreachable", async () => {
    // Markers all present, but /proc/loadavg is truncated garbage. The
    // shared parser throws and the host reports unknown rather than
    // rendering a verdict from half a reading.
    const entries = await probeHosts({
      targets: [REMOTE],
      runSsh: async () => snapshotPayload({ load: "not-a-loadavg" }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    const hig = entryFor(entries, "hig");
    expect(hig.reachable).toBe(false);
    expect(hig.error).toContain("loadavg");
  });

  test("malformed /proc/meminfo (MemTotal absent) is unreachable", async () => {
    const entries = await probeHosts({
      targets: [REMOTE],
      runSsh: async () => snapshotPayload({ mem: "MemAvailable:   33554432 kB" }),
      env: CLEAN_ENV,
      clock: () => 0,
    });
    expect(entryFor(entries, "hig").reachable).toBe(false);
    expect(entryFor(entries, "hig").error).toContain("MemTotal line absent");
  });

  test("an ssh target with no sshHost configured fails loudly", async () => {
    const entries = await probeHosts({
      targets: [{ name: "ghost", kind: "ssh", mounts: ["/"] }],
      env: CLEAN_ENV,
      clock: () => 0,
    });
    expect(entryFor(entries, "ghost").reachable).toBe(false);
    expect(entryFor(entries, "ghost").error).toContain("no sshHost");
  });

  test("the remote probe is told the REMOTE platform is linux", async () => {
    // Otherwise atmux running from a Mac would `skipped: true` the
    // remote Linux box and report it as fine without reading anything.
    let sawPlatform: string | undefined;
    await probeHosts({
      targets: [REMOTE],
      runSsh: async () => snapshotPayload({}),
      probeLocal: async (d) => {
        sawPlatform = d.platform;
        return probeHostPressure(d);
      },
      env: CLEAN_ENV,
      clock: () => 0,
    });
    expect(sawPlatform).toBe("linux");
  });
});

// ---------- Summary ----------

describe("summarizeHostReport", () => {
  test("all healthy → ok", () => {
    const s = summarizeHostReport([
      { host: "hax", reachable: true, verdict: okVerdict(16, 47), error: null, ms: 1 },
      { host: "hig", reachable: true, verdict: okVerdict(12, 72), error: null, ms: 1 },
    ]);
    expect(s).toEqual({ ok: true, unreachable: [], pressured: [], healthy: ["hax", "hig"] });
  });

  test("ONE unreachable host forces ok=false even when every other host is healthy", () => {
    // The single most important assertion in this file. If it inverts,
    // "is hig up?" answers "all good" while hig is on fire.
    const s = summarizeHostReport([
      { host: "hax", reachable: true, verdict: okVerdict(16, 47), error: null, ms: 1 },
      { host: "hig", reachable: false, verdict: null, error: "Connection refused", ms: 1 },
    ]);
    expect(s.ok).toBe(false);
    expect(s.unreachable).toEqual(["hig"]);
    expect(s.healthy).toEqual(["hax"]);
  });

  test("a pressured host forces ok=false", () => {
    const hot: HostPressureVerdict = { ...okVerdict(16, 96), ok: false, reasons: ["disk"] };
    const s = summarizeHostReport([
      { host: "hax", reachable: true, verdict: hot, error: null, ms: 1 },
    ]);
    expect(s.ok).toBe(false);
    expect(s.pressured).toEqual(["hax"]);
  });

  test("an EMPTY report is not ok — nothing measured is not all-clear", () => {
    expect(summarizeHostReport([]).ok).toBe(false);
  });

  test("a reachable entry with a null verdict counts as unreachable", () => {
    // Defensive: `reachable: true` with no verdict is an impossible pair
    // the type permits. It must fall to unknown, never to healthy.
    const s = summarizeHostReport([
      { host: "hax", reachable: true, verdict: null, error: null, ms: 1 },
    ]);
    expect(s.ok).toBe(false);
    expect(s.unreachable).toEqual(["hax"]);
  });
});

// ---------- Rendering ----------

describe("renderHostReport", () => {
  test("headline leads with UNREACHABLE and explicitly denies an all-clear", () => {
    const out = renderHostReport([
      { host: "hax", reachable: true, verdict: okVerdict(16, 47), error: null, ms: 1 },
      { host: "hig", reachable: false, verdict: null, error: "Connection refused", ms: 1 },
    ]);
    expect(out.split("\n")[0]).toBe(
      "HOSTS: 1 of 2 UNREACHABLE (hig) — that is not an all-clear.",
    );
    expect(out).toContain("hig — UNREACHABLE: Connection refused.");
    expect(out).toContain("Its headroom is unknown, not free.");
    // The word "healthy" must not attach to the unreachable host.
    const higLine = out.split("\n").find((l) => l.startsWith("hig")) ?? "";
    expect(higLine).not.toContain("HEALTHY");
  });

  test("load is normalised against THIS host's core count, not a constant", () => {
    // Same absolute load of 6.00 on a 16-core and a 12-core box must
    // render as different percentages, or the normalisation is a no-op.
    const mk = (cores: number): HostReportEntry => ({
      host: `h${cores}`,
      reachable: true,
      verdict: {
        ...okVerdict(cores, 47),
        probe: { ...okProbe(cores, 47), loadAvg1min: 6, loadAvg15min: 6 },
      },
      error: null,
      ms: 1,
    });
    const out = renderHostReport([mk(16), mk(12)]);
    expect(out).toContain("h16 — HEALTHY: cpu 38% of 16 cores"); // 6/16 = 37.5 → 38
    expect(out).toContain("h12 — HEALTHY: cpu 50% of 12 cores"); // 6/12 = 50
  });

  test("memory renders as a percentage USED plus the absolute headroom", () => {
    const out = renderHostReport([
      { host: "hax", reachable: true, verdict: okVerdict(16, 47), error: null, ms: 1 },
    ]);
    // 65536 total, 32768 available → 50% used, 32.0 GB available.
    expect(out).toContain("memory 50% used with 32.0 GB available");
  });

  test("disk renders per mount with its percentage and free space", () => {
    const out = renderHostReport([
      { host: "hax", reachable: true, verdict: okVerdict(16, 79), error: null, ms: 1 },
    ]);
    expect(out).toContain("disk / 79% full (97.7 GB free)");
  });

  test("an over-threshold host renders UNDER PRESSURE with the reasons attached", () => {
    const hot: HostPressureVerdict = {
      ...okVerdict(16, 96),
      ok: false,
      reasons: ["disk / 96% full > 90% threshold (8114MB free)"],
    };
    const out = renderHostReport([
      { host: "hax", reachable: true, verdict: hot, error: null, ms: 1 },
    ]);
    expect(out).toContain("HOSTS: 1 of 1 under pressure (hax).");
    expect(out).toContain("hax — UNDER PRESSURE:");
    expect(out).toContain("Over threshold: disk / 96% full > 90% threshold");
  });

  test("a missing mount is spoken, not omitted", () => {
    const missing: HostPressureVerdict = {
      ...okVerdict(16, 47),
      ok: false,
      reasons: ["disk /data not reported by df — headroom unknown, not assumed free"],
      probe: { ...okProbe(16, 47), missingMounts: ["/data"] },
    };
    const out = renderHostReport([
      { host: "hax", reachable: true, verdict: missing, error: null, ms: 1 },
    ]);
    expect(out).toContain("/data NOT REPORTED — unknown");
  });

  test("a skipped (non-Linux) probe renders NOT MEASURED, never healthy", () => {
    const skipped: HostPressureVerdict = {
      ok: true,
      reasons: [],
      probe: null,
      thresholds: null,
      skipped: true,
    };
    const out = renderHostReport([
      { host: "mac", reachable: true, verdict: skipped, error: null, ms: 1 },
    ]);
    expect(out).toContain("mac — NOT MEASURED");
    expect(out).toContain("Headroom unknown.");
    expect(out).not.toContain("mac — HEALTHY");
  });

  test("an empty report says so rather than rendering an all-clear", () => {
    expect(renderHostReport([])).toBe("HOSTS: no hosts configured to probe.");
  });
});

describe("speakProbeError — a reason a person can hear, not a command dump", () => {
  test("a spawn timeout loses the embedded argv and keeps the duration", () => {
    // SpawnTimeoutError embeds the ENTIRE remote script in its message.
    // Observed live: ~200 characters of shell read out loud. The reason
    // is what an operator needs; the command is already in this file.
    const raw =
      "ssh -o BatchMode=yes -o ConnectTimeout=1 hig echo '#atmux:loadavg'; cat /proc/loadavg; " +
      "echo '#atmux:meminfo'; cat /proc/meminfo; echo '#atmux:cpucount'; " +
      "grep -c '^processor' /proc/cpuinfo; echo '#atmux:df'; df -P -k '/' timed out after 250ms";
    const out = speakProbeError(raw, "hig");
    expect(out).toBe("ssh to hig timed out after 250ms");
    expect(out).not.toContain("/proc/");
    expect(out).not.toContain("BatchMode");
    expect(out.length).toBeLessThan(60);
  });

  test.each([
    ["Connection refused"],
    ["No route to host"],
    ["Could not resolve hostname"],
    ["Host key verification failed"],
    ["Permission denied"],
  ])("surfaces %p, because each implies a different fix", (phrase) => {
    expect(speakProbeError(`ssh: connect to host hig port 22: ${phrase}`, "hig")).toBe(
      `ssh to hig: ${phrase}`,
    );
  });

  test("a short parse error passes through unchanged", () => {
    expect(speakProbeError("snapshot missing section #atmux:loadavg", "hig")).toBe(
      "snapshot missing section #atmux:loadavg",
    );
  });

  test("an unrecognised long error is truncated rather than read in full", () => {
    const long = "x".repeat(400);
    const out = speakProbeError(long, "hig");
    expect(out.length).toBeLessThanOrEqual(161);
    expect(out.endsWith("…")).toBe(true);
  });

  test("only the first line survives — stderr dumps are not spoken", () => {
    expect(speakProbeError("first thing failed\nsecond line\nthird line", "hig")).toBe(
      "first thing failed",
    );
  });

  test("probeHosts stores the SPOKEN form, so the renderer never dumps a command", async () => {
    const entries = await probeHosts({
      targets: [REMOTE],
      runSsh: async () => {
        throw new Error(
          "ssh -o BatchMode=yes hig echo '#atmux:loadavg'; cat /proc/loadavg timed out after 15000ms",
        );
      },
      env: CLEAN_ENV,
      clock: () => 0,
    });
    expect(entryFor(entries, "hig").error).toBe("ssh to hig timed out after 15000ms");
    expect(renderHostReport(entries)).not.toContain("/proc/loadavg");
  });
});

describe("speakSize", () => {
  test.each([
    [0, "0 MB"],
    [512, "512 MB"],
    [1023, "1023 MB"],
    [1024, "1.0 GB"],
    [32768, "32.0 GB"],
    [97710, "95.4 GB"],
  ])("%p MB → %p", (mb, expected) => {
    expect(speakSize(mb)).toBe(expected);
  });

  test("a nonsense size is admitted as unknown, not rendered as a number", () => {
    expect(speakSize(Number.NaN)).toBe("unknown");
    expect(speakSize(-1)).toBe("unknown");
  });
});

// ---------- Target table ----------

describe("DEFAULT_HOST_TARGETS", () => {
  test("covers hax (local) and hig (ssh alias 'hig')", () => {
    expect(DEFAULT_HOST_TARGETS.map((t) => t.name)).toEqual(["hax", "hig"]);
    expect(DEFAULT_HOST_TARGETS[0]?.kind).toBe("local");
    expect(DEFAULT_HOST_TARGETS[1]?.kind).toBe("ssh");
    expect(DEFAULT_HOST_TARGETS[1]?.sshHost).toBe("hig");
  });

  test("no target hardcodes a core count — it is read per host", () => {
    // A baked core count is a number that silently goes wrong after a
    // resize, and every load percentage depends on it.
    for (const t of DEFAULT_HOST_TARGETS) {
      expect(Object.keys(t)).not.toContain("cpuCores");
    }
  });
});
