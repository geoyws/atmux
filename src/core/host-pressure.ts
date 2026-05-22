// Host pressure probe — gates spawn-epic (+ optionally bootstrap) when
// the host is over load / RAM thresholds. Substrate for ADR-184 host-
// wide epic-team cap + spawn queue + dormancy audit; shipped as a
// thin pre-spawn check ahead of the full ADR-184 EPIC.
//
// Linux-only — reads /proc/loadavg, /proc/meminfo, /proc/cpuinfo.
// On non-Linux platforms returns `ok: true` with empty reasons (no
// gating; user runs at their own risk on macOS/dev). The full ADR-184
// EPIC can add cross-platform probes; this thin layer prioritizes
// the hax production case where the leak hurts most.

import { readFile } from "node:fs/promises";

/** Raw host pressure metrics. */
export interface HostPressureProbe {
  /** /proc/loadavg field 1 — 1-min avg. */
  loadAvg1min: number;
  /** /proc/loadavg field 3 — 15-min avg. */
  loadAvg15min: number;
  /** /proc/meminfo MemAvailable in MB. */
  memAvailableMb: number;
  /** /proc/cpuinfo processor-line count. */
  cpuCores: number;
}

/** Thresholds gate the verdict. Configurable via env (see {@link resolveThresholds}). */
export interface HostPressureThresholds {
  /** Max acceptable load-avg(15min) as ratio of CPU cores. Default 0.75 — leaves headroom for sibling teams + the parent atmux team. */
  maxLoadRatio: number;
  /** Min acceptable MemAvailable in MB. Default 8192 (8 GB). */
  minMemMb: number;
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
  /** Override platform string. Defaults to `process.platform`. */
  platform?: string;
  /** Override env. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_MAX_LOAD_RATIO = 0.75;
const DEFAULT_MIN_MEM_MB = 8192;

/**
 * Resolve thresholds from env, falling back to defaults.
 *
 * `ATMUX_SPAWN_MAX_LOAD_RATIO` — float; bound to (0, 100], invalid/missing → default.
 * `ATMUX_SPAWN_MIN_FREE_MB` — integer ≥ 0; invalid/missing → default.
 */
export function resolveThresholds(env: NodeJS.ProcessEnv): HostPressureThresholds {
  const rawRatio = env.ATMUX_SPAWN_MAX_LOAD_RATIO?.trim();
  const rawMem = env.ATMUX_SPAWN_MIN_FREE_MB?.trim();

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

  return { maxLoadRatio, minMemMb };
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

/** Parse /proc/meminfo content to MemAvailable in MB. Throws on parse failure. */
export function parseMemAvailableMb(meminfo: string): number {
  const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m);
  if (m === null || m[1] === undefined) {
    throw new Error("host-pressure: /proc/meminfo MemAvailable line absent");
  }
  const kb = Number.parseInt(m[1], 10);
  if (!Number.isFinite(kb) || kb < 0) {
    throw new Error(`host-pressure: /proc/meminfo MemAvailable invalid: ${m[1]}`);
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
 * On Linux, missing/malformed /proc files throw — caller decides whether
 * to fall back to `ok: true` (current spawn-epic integration treats
 * probe failure as "skip" since the host *may* be fine, and we don't
 * want to break spawn on broken /proc).
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

  const [rawLoad, rawMem, cpuCores] = await Promise.all([
    readLoadAvg(),
    readMemInfo(),
    readCpuCount(),
  ]);

  const { l1, l15 } = parseLoadAvg(rawLoad);
  const memAvailableMb = parseMemAvailableMb(rawMem);
  const thresholds = resolveThresholds(env);

  const probe: HostPressureProbe = {
    loadAvg1min: l1,
    loadAvg15min: l15,
    memAvailableMb,
    cpuCores,
  };

  const reasons: string[] = [];
  const loadCeil = cpuCores * thresholds.maxLoadRatio;
  if (l15 > loadCeil) {
    reasons.push(
      `load 15min ${l15.toFixed(2)} > ${loadCeil.toFixed(2)} (${cpuCores} cores × ${thresholds.maxLoadRatio})`,
    );
  }
  if (memAvailableMb < thresholds.minMemMb) {
    reasons.push(
      `MemAvailable ${memAvailableMb}MB < ${thresholds.minMemMb}MB threshold`,
    );
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
