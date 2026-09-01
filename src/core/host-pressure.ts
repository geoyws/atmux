// Host pressure probe — gates spawn-epic (+ optionally bootstrap) when
// the host is over load / RAM thresholds. Substrate for ADR-184 host-
// wide epic-team cap + spawn queue + dormancy audit; shipped as a
// thin pre-spawn check ahead of the full ADR-184 EPIC.
//
// Linux-only — reads /proc/loadavg, /proc/meminfo, /proc/cpuinfo, and
// `df -P -k` for the disk dimension.
// On non-Linux platforms returns `ok: true` with empty reasons (no
// gating; user runs at their own risk on macOS/dev). The full ADR-184
// EPIC can add cross-platform probes; this thin layer prioritizes
// the hax production case where the leak hurts most.
//
// ---------------------------------------------------------------------
// The disk dimension (ADR-273 §Supplement)
// ---------------------------------------------------------------------
//
// Added here rather than in the caller that wanted it, so BOTH callers
// benefit: `atmux doctor`'s host-pressure row, the ADR-184 spawn-epic
// gate, and the ADR-273 `host_pressure` voice tool all read one probe.
//
// Disk participates in the VERDICT, it is not merely measured. A probe
// that reads a dimension and then excludes it from `ok` would report
// `ok: true` on a host whose disk is 99% full — which is precisely the
// "absence of a complaint is not evidence of health" failure this
// module exists to prevent, and a full disk is exactly what breaks
// `git worktree add`, the first thing spawn-epic does.
//
// A mount that `df` does not report is a REASON, never a pass. Asking
// about a mount and getting silence tells you nothing about its
// headroom; treating that silence as "fine" is the same lie one level
// down.

import { readFile } from "node:fs/promises";

/** One mount's usage, as `df -P -k` reports it. */
export interface DiskUsage {
  /** Mount point (df's "Mounted on" column). */
  mount: string;
  /** Total 1K-blocks, converted to MB. */
  totalMb: number;
  /** Available 1K-blocks, converted to MB. */
  availableMb: number;
  /** df's own Capacity column (0-100). This is the number `df -h`
   *  prints and the number the hig sentinel alerts on, so the tool and
   *  the operator's own shell agree. */
  usedPercent: number;
}

/** Result of reading `df` for a requested mount list. */
export interface DiskSnapshot {
  /** One entry per mount df actually reported, de-duplicated by mount. */
  disks: DiskUsage[];
  /** Requested mounts df did NOT report. Never silently dropped. */
  missingMounts: string[];
}

/** Mounts probed when the caller names none. */
export const DEFAULT_MOUNTS: ReadonlyArray<string> = Object.freeze(["/"]);

/** Raw host pressure metrics. */
export interface HostPressureProbe {
  /** /proc/loadavg field 1 — 1-min avg. */
  loadAvg1min: number;
  /** /proc/loadavg field 3 — 15-min avg. */
  loadAvg15min: number;
  /** /proc/meminfo MemAvailable in MB. */
  memAvailableMb: number;
  /** /proc/meminfo MemTotal in MB. Carried so a caller can render
   *  headroom as a PERCENTAGE — "34% used" is hearable, "21503MB
   *  available" is not. */
  memTotalMb: number;
  /** /proc/cpuinfo processor-line count. */
  cpuCores: number;
  /** Per-mount disk usage. */
  disks: DiskUsage[];
  /** Requested mounts df did not report — unknown, not healthy. */
  missingMounts: string[];
}

/** Thresholds gate the verdict. Configurable via env (see {@link resolveThresholds}). */
export interface HostPressureThresholds {
  /** Max acceptable load-avg(15min) as ratio of CPU cores. Default 0.75 — leaves headroom for sibling teams + the parent atmux team. */
  maxLoadRatio: number;
  /** Min acceptable MemAvailable in MB. Default 8192 (8 GB). */
  minMemMb: number;
  /** Max acceptable per-mount used percentage. Default 90 — the same
   *  line the hig sentinel already alerts on, so one host does not have
   *  two different definitions of "disk is full". */
  maxDiskPercent: number;
}

/** Verdict surface. */
export interface HostPressureVerdict {
  /** `true` when ALL thresholds pass (or platform is non-Linux). */
  ok: boolean;
  /** Per-threshold violation reasons. Empty when `ok`. */
  reasons: string[];
  /** Raw probe data — null on non-Linux platforms. */
  probe: HostPressureProbe | null;
  /** Resolved thresholds — null on non-Linux platforms. */
  thresholds: HostPressureThresholds | null;
  /** `true` when platform is non-Linux + probe is skipped. */
  skipped: boolean;
}

/** Dependency injection seam for tests. */
export interface ProbeHostPressureDeps {
  /** Override /proc/loadavg read. */
  readLoadAvg?: () => Promise<string>;
  /** Override /proc/meminfo read. */
  readMemInfo?: () => Promise<string>;
  /** Override CPU core count read. */
  readCpuCount?: () => Promise<number>;
  /** Override the raw `df -P -k` text. Receives the resolved mount list
   *  so an injected reader can honour it. */
  readDf?: (mounts: ReadonlyArray<string>) => Promise<string>;
  /** Mounts to probe. Defaults to {@link DEFAULT_MOUNTS}. */
  mounts?: ReadonlyArray<string>;
  /** Override platform string. Defaults to `process.platform`. */
  platform?: string;
  /** Override env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_LOAD_RATIO = 0.75;
const DEFAULT_MIN_MEM_MB = 8192;
const DEFAULT_MAX_DISK_PERCENT = 90;

/**
 * Resolve thresholds from env, falling back to defaults.
 *
 * `ATMUX_SPAWN_MAX_LOAD_RATIO` — float; bound to (0, 100], invalid/missing → default.
 * `ATMUX_SPAWN_MIN_FREE_MB` — integer ≥ 0; invalid/missing → default.
 * `ATMUX_SPAWN_MAX_DISK_PERCENT` — float; bound to (0, 100], invalid/missing → default.
 */
export function resolveThresholds(env: NodeJS.ProcessEnv): HostPressureThresholds {
  const rawRatio = env.ATMUX_SPAWN_MAX_LOAD_RATIO?.trim();
  const rawMem = env.ATMUX_SPAWN_MIN_FREE_MB?.trim();
  const rawDisk = env.ATMUX_SPAWN_MAX_DISK_PERCENT?.trim();

  let maxLoadRatio = DEFAULT_MAX_LOAD_RATIO;
  if (rawRatio !== undefined && rawRatio.length > 0) {
    const n = Number.parseFloat(rawRatio);
    if (Number.isFinite(n) && n > 0 && n <= 100) maxLoadRatio = n;
  }

  let minMemMb = DEFAULT_MIN_MEM_MB;
  if (rawMem !== undefined && rawMem.length > 0) {
    const n = Number.parseInt(rawMem, 10);
    if (Number.isInteger(n) && n >= 0) minMemMb = n;
  }

  let maxDiskPercent = DEFAULT_MAX_DISK_PERCENT;
  if (rawDisk !== undefined && rawDisk.length > 0) {
    const n = Number.parseFloat(rawDisk);
    if (Number.isFinite(n) && n > 0 && n <= 100) maxDiskPercent = n;
  }

  return { maxLoadRatio, minMemMb, maxDiskPercent };
}

/** Default loadavg reader. */
async function defaultReadLoadAvg(): Promise<string> {
  return readFile("/proc/loadavg", "utf8");
}

/** Default meminfo reader. */
async function defaultReadMemInfo(): Promise<string> {
  return readFile("/proc/meminfo", "utf8");
}

/** Default CPU count — scans /proc/cpuinfo for `processor` lines. */
async function defaultReadCpuCount(): Promise<number> {
  const raw = await readFile("/proc/cpuinfo", "utf8");
  let n = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("processor")) n += 1;
  }
  return Math.max(1, n);
}

/** Default `df` reader — one `df -P -k <mounts>` subprocess.
 *
 *  `-P` pins the POSIX one-line-per-filesystem format (a wrapped device
 *  name would otherwise split a row across two lines and the parser
 *  would read the halves as garbage); `-k` pins 1K blocks so the units
 *  are not locale- or `DF_BLOCK_SIZE`-dependent.
 *
 *  `expectExitCode: "any"` because df exits non-zero when ANY named
 *  mount is missing while still printing the rows for the ones that do
 *  exist. Discarding that output would turn a partial answer into no
 *  answer; the parser reports the missing mount from the absence of its
 *  row instead. */
async function defaultReadDf(mounts: ReadonlyArray<string>): Promise<string> {
  const { spawn } = await import("../abstractions/spawn.ts");
  const r = await spawn({
    cmd: "df",
    argv: ["-P", "-k", ...mounts],
    expectExitCode: "any",
    timeoutMs: 10_000,
  });
  return r.stdout;
}

/**
 * Parse `df -P -k` output into per-mount usage, and name every requested
 * mount df did not report.
 *
 * De-duplicates by mount: `df -P -k / /root` prints the SAME row twice
 * when both paths live on one filesystem, and counting one mount twice
 * would double its weight in any downstream verdict.
 */
export function parseDfOutput(text: string, mounts: ReadonlyArray<string>): DiskSnapshot {
  const byMount = new Map<string, DiskUsage>();
  for (const line of text.split("\n")) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\S.*?)\s*$/);
    if (m === null) continue; // header, blank line, or df's stderr echo
    const totalKb = Number.parseInt(m[2] as string, 10);
    const availKb = Number.parseInt(m[4] as string, 10);
    const pct = Number.parseInt(m[5] as string, 10);
    const mount = m[6] as string;
    if (!Number.isFinite(totalKb) || !Number.isFinite(availKb) || !Number.isFinite(pct)) continue;
    if (!byMount.has(mount)) {
      byMount.set(mount, {
        mount,
        totalMb: Math.floor(totalKb / 1024),
        availableMb: Math.floor(availKb / 1024),
        usedPercent: pct,
      });
    }
  }
  const disks = [...byMount.values()];
  // EXACT match on df's "Mounted on" column, deliberately.
  //
  // The tempting alternative — treat a requested path as covered by any
  // ancestor mount, so `/root` counts as covered by `/` — is unsound in
  // the one direction that matters: `/` is an ancestor of EVERY absolute
  // path, so it would mark a genuinely absent `/data` as covered and the
  // missing-mount detection would never fire while `/` was also probed.
  // That is the default configuration, so the check would be dead on
  // arrival.
  //
  // Exact matching is also what the config means. `mounts` are mount
  // POINTS, not arbitrary paths, so a configured mount df does not
  // report is a real misconfiguration worth naming rather than a
  // near-miss to be smoothed over.
  const reported = new Set(disks.map((d) => d.mount));
  const missingMounts = mounts.filter((m) => !reported.has(m));
  return { disks, missingMounts };
}

/** Parse /proc/meminfo content to MemAvailable in MB. Throws on parse failure. */
export function parseMemAvailableMb(meminfo: string): number {
  return parseMemFieldMb(meminfo, "MemAvailable");
}

/** Parse /proc/meminfo content to MemTotal in MB. Throws on parse failure. */
export function parseMemTotalMb(meminfo: string): number {
  return parseMemFieldMb(meminfo, "MemTotal");
}

/** Shared /proc/meminfo field parser — one implementation, two callers,
 *  so a fix to the line shape can never land on only one of them. */
function parseMemFieldMb(meminfo: string, field: "MemAvailable" | "MemTotal"): number {
  const m = meminfo.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB\\s*$`, "m"));
  if (m === null || m[1] === undefined) {
    throw new Error(`host-pressure: /proc/meminfo ${field} line absent`);
  }
  const kb = Number.parseInt(m[1], 10);
  if (!Number.isFinite(kb) || kb < 0) {
    throw new Error(`host-pressure: /proc/meminfo ${field} invalid: ${m[1]}`);
  }
  return Math.floor(kb / 1024);
}

/** Parse /proc/loadavg first + third fields. Throws on parse failure. */
export function parseLoadAvg(loadavg: string): { l1: number; l15: number } {
  const parts = loadavg.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new Error(`host-pressure: /proc/loadavg malformed: ${loadavg}`);
  }
  const l1 = Number.parseFloat(parts[0] as string);
  const l15 = Number.parseFloat(parts[2] as string);
  if (!Number.isFinite(l1) || !Number.isFinite(l15) || l1 < 0 || l15 < 0) {
    throw new Error(`host-pressure: /proc/loadavg invalid: ${loadavg}`);
  }
  return { l1, l15 };
}

/**
 * Probe host pressure + render verdict against thresholds.
 *
 * On non-Linux platforms returns `{ok: true, skipped: true, probe: null}`
 * — atmux runs on macOS dev too, where this gate would be noise.
 *
 * On Linux, missing/malformed /proc files THROW, and the caller sees it.
 *
 * An earlier version of this comment claimed spawn-epic "treats probe
 * failure as skip"; it does not — `spawn-epic.ts` awaits `probe({env})`
 * with no try/catch, so a throw here propagates as a spawn failure.
 * That is tolerable for /proc, which does not fail on a live Linux box,
 * and is precisely why the `df` read (the one subprocess) is caught
 * inside this function instead. Corrected 2026-08-17 by reading the
 * callsite rather than inheriting the claim.
 */
export async function probeHostPressure(
  deps: ProbeHostPressureDeps = {},
): Promise<HostPressureVerdict> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;

  if (platform !== "linux") {
    return { ok: true, reasons: [], probe: null, thresholds: null, skipped: true };
  }

  const readLoadAvg = deps.readLoadAvg ?? defaultReadLoadAvg;
  const readMemInfo = deps.readMemInfo ?? defaultReadMemInfo;
  const readCpuCount = deps.readCpuCount ?? defaultReadCpuCount;
  const readDf = deps.readDf ?? defaultReadDf;
  const mounts = deps.mounts ?? DEFAULT_MOUNTS;

  // The disk read is the only dimension that shells out to a
  // SUBPROCESS, so it is the only one with a realistic runtime failure
  // (missing binary, PATH, a spawn timeout under the very load we are
  // measuring). `probeHostPressure` is called WITHOUT a try/catch on
  // spawn-epic's hot path, so letting a `df` hiccup throw would turn a
  // measurement problem into a hard refusal to spawn anything at all.
  //
  // It fails SOFT but not SILENT: the error is captured, every
  // requested mount lands in `missingMounts`, and the verdict goes
  // not-ok with the reason. Disk headroom we could not read is unknown,
  // and unknown still gates — a host whose `df` will not run is a host
  // worth refusing a 7-agent epic-team on. `--force-spawn` remains the
  // operator's override.
  const [rawLoad, rawMem, cpuCores, dfResult] = await Promise.all([
    readLoadAvg(),
    readMemInfo(),
    readCpuCount(),
    readDf(mounts).then(
      (text) => ({ text, error: null as string | null }),
      (e: unknown) => ({ text: "", error: e instanceof Error ? e.message : String(e) }),
    ),
  ]);
  const rawDf = dfResult.text;
  const dfError = dfResult.error;

  const { l1, l15 } = parseLoadAvg(rawLoad);
  const memAvailableMb = parseMemAvailableMb(rawMem);
  const memTotalMb = parseMemTotalMb(rawMem);
  const { disks, missingMounts } = parseDfOutput(rawDf, mounts);
  const thresholds = resolveThresholds(env);

  const probe: HostPressureProbe = {
    loadAvg1min: l1,
    loadAvg15min: l15,
    memAvailableMb,
    memTotalMb,
    cpuCores,
    disks,
    missingMounts,
  };

  const reasons: string[] = [];
  const loadCeil = cpuCores * thresholds.maxLoadRatio;
  if (l15 > loadCeil) {
    reasons.push(
      `load 15min ${l15.toFixed(2)} > ${loadCeil.toFixed(2)} (${cpuCores} cores × ${thresholds.maxLoadRatio})`,
    );
  }
  if (memAvailableMb < thresholds.minMemMb) {
    reasons.push(`MemAvailable ${memAvailableMb}MB < ${thresholds.minMemMb}MB threshold`);
  }
  for (const d of disks) {
    if (d.usedPercent > thresholds.maxDiskPercent) {
      reasons.push(
        `disk ${d.mount} ${d.usedPercent}% full > ${thresholds.maxDiskPercent}% threshold (${d.availableMb}MB free)`,
      );
    }
  }
  if (dfError !== null) {
    // One clear reason rather than one per mount — the mounts are all
    // "missing" because the reader never ran, and N copies of that would
    // bury the actual cause.
    reasons.push(`disk unreadable — df failed: ${dfError} (headroom unknown, not assumed free)`);
  } else {
    for (const m of missingMounts) {
      // Unknown, never assumed fine — see the file header.
      reasons.push(`disk ${m} not reported by df — headroom unknown, not assumed free`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    probe,
    thresholds,
    skipped: false,
  };
}

/**
 * Format a verdict for operator-facing error messages. Includes the
 * actionable hint: wait, override with --force-spawn, or tune thresholds.
 */
export function formatPressureError(verdict: HostPressureVerdict): string {
  if (verdict.skipped || verdict.ok) return "";
  const lines = [
    `host under pressure — refusing spawn:`,
    ...verdict.reasons.map((r) => `  - ${r}`),
  ];
  return lines.join("\n");
}
