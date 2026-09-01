// ADR-273 §Supplement: `host_pressure` — CPU / memory / disk headroom
// for every host the fleet runs on, rendered to be HEARD.
//
// ---------------------------------------------------------------------
// One probe, two hosts
// ---------------------------------------------------------------------
//
// There is exactly one pressure implementation: `src/core/host-pressure.ts`.
// The local host calls it with its default readers; the remote host calls
// the SAME function with readers that serve pre-fetched text from one ssh
// round trip. Every parse, every threshold and every verdict is therefore
// shared — a second implementation for "the remote one" is how the two
// hosts would start disagreeing about what 90% full means.
//
// ---------------------------------------------------------------------
// Unreachable is NOT healthy
// ---------------------------------------------------------------------
//
// This is the load-bearing rule of the module and the reason it exists in
// this shape. If the ssh call fails, times out, or returns a payload we
// cannot parse, the host is reported `reachable: false` with the reason —
// never as a verdict, never omitted from the report, and never folded
// into an "all clear". A host being down is the single most important
// thing this tool can tell the operator, and a report that quietly drops
// an unreachable host says "everything is fine" using the absence of
// evidence as the evidence. That failure class has already cost this
// repo one bug; it does not get to cost a second.
//
// The corollary is that the OVERALL verdict can never be `ok` while any
// host is unreachable — {@link summarizeHostReport} enforces that, and a
// unit test drives the hig-down case specifically.
//
// ---------------------------------------------------------------------
// Why the remote read is one command
// ---------------------------------------------------------------------
//
// Four separate ssh invocations would be four TCP handshakes, four auth
// rounds and four chances to half-fail (three dimensions answered, one
// timed out — which is the ambiguous state we most want to avoid). One
// command emits all four sections behind sentinel markers; if the
// payload is short a section, the whole host reports unreachable with
// that named as the reason.
//
// Everything it runs is READ-ONLY: `cat` on two /proc files, `grep -c`
// on a third, and `df`. Nothing is written, installed, or loaded.

import {
  DEFAULT_MOUNTS,
  type HostPressureVerdict,
  probeHostPressure,
  type ProbeHostPressureDeps,
} from "../host-pressure.ts";

// ---------- Targets ----------

/** One host the report covers. */
export interface HostTarget {
  /** Operator-facing name — what the model says aloud. */
  name: string;
  /** `local` reads /proc directly; `ssh` goes through {@link HostReportDeps.runSsh}. */
  kind: "local" | "ssh";
  /** ssh destination (a `~/.ssh/config` alias). Only for `kind: "ssh"`. */
  sshHost?: string;
  /** Mounts to probe on this host. */
  mounts: ReadonlyArray<string>;
}

/**
 * The fleet's hosts. `hax` is where atmux itself runs (local); `hig` is
 * the deployment target, reachable as the ssh alias `hig`.
 *
 * Core count is NOT recorded here on purpose — it is READ from each host
 * (`/proc/cpuinfo`), because a hardcoded core count is a number that
 * silently goes wrong after a resize, and load normalisation is only
 * meaningful against the real one.
 */
export const DEFAULT_HOST_TARGETS: ReadonlyArray<HostTarget> = Object.freeze([
  Object.freeze({ name: "hax", kind: "local", mounts: DEFAULT_MOUNTS }) as HostTarget,
  Object.freeze({
    name: "hig",
    kind: "ssh",
    sshHost: "hig",
    mounts: DEFAULT_MOUNTS,
  }) as HostTarget,
]);

// ---------- Remote snapshot ----------

/** Section markers in the remote payload. NUL-free but distinctive
 *  enough that no /proc or df line can pose as one. */
export const SNAPSHOT_MARKERS = Object.freeze({
  load: "#atmux:loadavg",
  mem: "#atmux:meminfo",
  cpu: "#atmux:cpucount",
  df: "#atmux:df",
});

/** Shell-quote a token so the REMOTE shell reads it as one literal. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the single read-only shell command the remote host runs.
 *
 * Every marker is SINGLE-QUOTED, and that is load-bearing rather than
 * cosmetic: the markers begin with `#`, so an unquoted `echo #atmux:...`
 * is a shell COMMENT and prints nothing. The first live run against hig
 * reported the host unreachable for exactly that reason — the payload
 * came back with no section headers at all. (The failure was at least
 * honest: an unparseable payload reported UNREACHABLE rather than
 * healthy, which is the module's whole contract working.)
 */
export function buildSnapshotCommand(mounts: ReadonlyArray<string>): string {
  const mountArgs = mounts.map(shq).join(" ");
  return [
    `echo ${shq(SNAPSHOT_MARKERS.load)}`,
    "cat /proc/loadavg",
    `echo ${shq(SNAPSHOT_MARKERS.mem)}`,
    "cat /proc/meminfo",
    `echo ${shq(SNAPSHOT_MARKERS.cpu)}`,
    "grep -c '^processor' /proc/cpuinfo",
    `echo ${shq(SNAPSHOT_MARKERS.df)}`,
    `df -P -k ${mountArgs}`,
  ].join("; ");
}

/** The four sections of a remote snapshot, already split. */
export interface HostSnapshot {
  loadavg: string;
  meminfo: string;
  cpuCount: number;
  df: string;
}

/**
 * Split a remote payload into its four sections.
 *
 * Throws when a section is absent or the cpu count is not a positive
 * integer. Throwing (rather than defaulting) is deliberate: a partial
 * payload must surface as UNREACHABLE, and a defaulted core count would
 * silently make every load percentage wrong instead.
 */
export function parseSnapshot(raw: string): HostSnapshot {
  const section = (marker: string, next: string | null): string => {
    const start = raw.indexOf(`${marker}\n`);
    if (start === -1) throw new Error(`snapshot missing section ${marker}`);
    const from = start + marker.length + 1;
    if (next === null) return raw.slice(from);
    const end = raw.indexOf(`${next}\n`, from);
    if (end === -1) throw new Error(`snapshot missing section ${next}`);
    return raw.slice(from, end);
  };
  const loadavg = section(SNAPSHOT_MARKERS.load, SNAPSHOT_MARKERS.mem);
  const meminfo = section(SNAPSHOT_MARKERS.mem, SNAPSHOT_MARKERS.cpu);
  const cpuRaw = section(SNAPSHOT_MARKERS.cpu, SNAPSHOT_MARKERS.df).trim();
  const df = section(SNAPSHOT_MARKERS.df, null);
  const cpuCount = Number.parseInt(cpuRaw, 10);
  if (!Number.isInteger(cpuCount) || cpuCount < 1) {
    throw new Error(`snapshot cpu count invalid: ${JSON.stringify(cpuRaw)}`);
  }
  return { loadavg, meminfo, cpuCount, df };
}

// ---------- Probe ----------

/** Outcome for ONE host. Exactly one of `verdict` / `error` is set. */
export interface HostReportEntry {
  host: string;
  /** False ⇒ nothing is known about this host's headroom. */
  reachable: boolean;
  /** The shared pressure verdict. `null` when unreachable. */
  verdict: HostPressureVerdict | null;
  /** Why the host could not be read. `null` when reachable. */
  error: string | null;
  /** How long the probe took, ms. */
  ms: number;
}

/** Injected boundaries — every one of them is faked in tests. */
export interface HostReportDeps {
  targets?: ReadonlyArray<HostTarget>;
  /** Run a command on a remote host. Rejects on failure/timeout. */
  runSsh?: (sshHost: string, command: string, timeoutMs: number) => Promise<string>;
  /** Local pressure probe. Defaults to the real one. */
  probeLocal?: (deps: ProbeHostPressureDeps) => Promise<HostPressureVerdict>;
  /** Per-host ssh budget. Defaults to {@link resolveHostProbeTimeoutMs}. */
  timeoutMs?: number;
  /** Monotonic-enough ms clock. */
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
}

/** Default ssh budget, ms. Short on purpose — a voice tool that hangs is
 *  worse than one that errors, because the operator gets neither an
 *  answer nor a reason. */
export const DEFAULT_HOST_PROBE_TIMEOUT_MS = 15_000;

/**
 * Resolve the per-host ssh budget from `ATMUX_HOST_PROBE_TIMEOUT_MS`.
 *
 * Fails CLOSED to the default on missing / non-numeric / non-finite /
 * non-positive values — the same contract `resolveDefaultTimeoutMs` in
 * `src/abstractions/spawn.ts` uses, so an operator who has learned one
 * knob has learned this one.
 */
export function resolveHostProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ATMUX_HOST_PROBE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOST_PROBE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOST_PROBE_TIMEOUT_MS;
  return n;
}

/** Default ssh runner — `BatchMode=yes` so a host that would prompt for a
 *  password FAILS instead of hanging on a tty nobody is watching. */
async function defaultRunSsh(sshHost: string, command: string, timeoutMs: number): Promise<string> {
  const { spawn } = await import("../../abstractions/spawn.ts");
  const connectTimeoutSec = Math.max(1, Math.floor(timeoutMs / 2000));
  const r = await spawn({
    cmd: "ssh",
    argv: ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${connectTimeoutSec}`, sshHost, command],
    timeoutMs,
    // df exits non-zero for a missing mount while still printing the
    // rows that DO exist; the parser decides, not the exit code.
    expectExitCode: "any",
  });
  return r.stdout;
}

/** ssh failure phrases worth surfacing verbatim — each one tells the
 *  operator a DIFFERENT thing to do about it. */
const SSH_FAILURE_PHRASES: ReadonlyArray<string> = Object.freeze([
  "Connection refused",
  "Connection timed out",
  "No route to host",
  "Could not resolve hostname",
  "Host key verification failed",
  "Permission denied",
  "Network is unreachable",
]);

/** Longest error we will read aloud before truncating. */
const MAX_SPOKEN_ERROR_CHARS = 160;

/**
 * Reduce a probe failure to something a person can HEAR.
 *
 * `SpawnTimeoutError` embeds the entire argv in its message, so the raw
 * text is the whole remote script — ~200 characters of shell an operator
 * gains nothing from and a voice assistant would read out loud. Observed
 * on the first live timeout run. The reason is what matters; the command
 * is already in this file.
 */
export function speakProbeError(raw: string, sshHost: string): string {
  const first = raw.split("\n")[0]?.trim() ?? "";
  for (const phrase of SSH_FAILURE_PHRASES) {
    if (raw.includes(phrase)) return `ssh to ${sshHost}: ${phrase}`;
  }
  const timeout = raw.match(/timed out after (\d+)\s*ms/);
  if (timeout !== null) return `ssh to ${sshHost} timed out after ${timeout[1]}ms`;
  if (first.length <= MAX_SPOKEN_ERROR_CHARS) return first;
  return `${first.slice(0, MAX_SPOKEN_ERROR_CHARS)}…`;
}

/** Probe every target. Never throws — a failure becomes an entry. */
export async function probeHosts(deps: HostReportDeps = {}): Promise<HostReportEntry[]> {
  const targets = deps.targets ?? DEFAULT_HOST_TARGETS;
  const env = deps.env ?? process.env;
  const clock = deps.clock ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? resolveHostProbeTimeoutMs(env);
  const runSsh = deps.runSsh ?? defaultRunSsh;
  const probe = deps.probeLocal ?? probeHostPressure;

  return Promise.all(
    targets.map(async (t): Promise<HostReportEntry> => {
      const start = clock();
      try {
        if (t.kind === "local") {
          const verdict = await probe({ mounts: t.mounts, env });
          return { host: t.name, reachable: true, verdict, error: null, ms: clock() - start };
        }
        if (t.sshHost === undefined || t.sshHost === "") {
          throw new Error("ssh target has no sshHost configured");
        }
        const raw = await runSsh(t.sshHost, buildSnapshotCommand(t.mounts), timeoutMs);
        const snap = parseSnapshot(raw);
        // Same probe, pre-fetched readers. No second implementation.
        const verdict = await probe({
          readLoadAvg: async () => snap.loadavg,
          readMemInfo: async () => snap.meminfo,
          readCpuCount: async () => snap.cpuCount,
          readDf: async () => snap.df,
          mounts: t.mounts,
          // The REMOTE host is Linux; `process.platform` describes the
          // box we are sitting on, which would skip the probe entirely
          // when atmux runs from a Mac.
          platform: "linux",
          env,
        });
        return { host: t.name, reachable: true, verdict, error: null, ms: clock() - start };
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        return {
          host: t.name,
          reachable: false,
          verdict: null,
          error: speakProbeError(raw, t.sshHost ?? t.name),
          ms: clock() - start,
        };
      }
    }),
  );
}

// ---------- Verdict + rendering ----------

/** Overall shape of the report. */
export interface HostReportSummary {
  /** True ONLY when every host was read AND every host is under
   *  threshold. An unreachable host can never produce `true`. */
  ok: boolean;
  /** Hosts that could not be read at all. */
  unreachable: string[];
  /** Hosts read successfully but over at least one threshold. */
  pressured: string[];
  /** Hosts read successfully and under every threshold. */
  healthy: string[];
}

/** Fold per-host entries into one verdict. See the file header for why
 *  `unreachable` forces `ok: false`. */
export function summarizeHostReport(entries: ReadonlyArray<HostReportEntry>): HostReportSummary {
  const unreachable: string[] = [];
  const pressured: string[] = [];
  const healthy: string[] = [];
  for (const e of entries) {
    if (!e.reachable || e.verdict === null) {
      unreachable.push(e.host);
    } else if (e.verdict.ok) {
      healthy.push(e.host);
    } else {
      pressured.push(e.host);
    }
  }
  return {
    ok: unreachable.length === 0 && pressured.length === 0 && healthy.length > 0,
    unreachable,
    pressured,
    healthy,
  };
}

/** Round to a whole percent, clamped to [0, 999] so a nonsense input
 *  cannot render as `-Infinity%`. */
function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(999, Math.max(0, Math.round((part / whole) * 100)));
}

/** MB → a spoken size. Under 1024MB stays in MB; above becomes GB with
 *  one decimal, because "sixty-one point five gigabytes" is hearable and
 *  "sixty-two thousand nine hundred and forty megabytes" is not. */
export function speakSize(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "unknown";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** One host's line. */
function renderEntry(e: HostReportEntry): string {
  if (!e.reachable || e.verdict === null) {
    // Named, with the reason, and explicitly NOT counted as fine.
    return `${e.host} — UNREACHABLE: ${e.error ?? "unknown error"}. Its headroom is unknown, not free.`;
  }
  const v = e.verdict;
  if (v.skipped || v.probe === null || v.thresholds === null) {
    return `${e.host} — NOT MEASURED: pressure probe skipped on this platform. Headroom unknown.`;
  }
  const p = v.probe;
  // Load normalised against THIS host's real core count — a load of 8
  // is half of a 16-core box and two thirds of a 12-core one.
  const cpuPct = pct(p.loadAvg15min, p.cpuCores);
  const cpuNowPct = pct(p.loadAvg1min, p.cpuCores);
  const memUsedPct = pct(p.memTotalMb - p.memAvailableMb, p.memTotalMb);
  const diskParts = p.disks.map(
    (d) => `${d.mount} ${d.usedPercent}% full (${speakSize(d.availableMb)} free)`,
  );
  for (const m of p.missingMounts) diskParts.push(`${m} NOT REPORTED — unknown`);
  const disk = diskParts.length > 0 ? diskParts.join(", ") : "no mounts reported — unknown";
  const body =
    `cpu ${cpuPct}% of ${p.cpuCores} cores over 15 min (${cpuNowPct}% right now), ` +
    `memory ${memUsedPct}% used with ${speakSize(p.memAvailableMb)} available, ` +
    `disk ${disk}`;
  if (v.ok) return `${e.host} — HEALTHY: ${body}.`;
  return `${e.host} — UNDER PRESSURE: ${body}. Over threshold: ${v.reasons.join("; ")}.`;
}

/**
 * Render the whole report as speakable lines.
 *
 * The headline never says "all clear" while a host is unreachable; it
 * says how many hosts could not be read, first.
 */
export function renderHostReport(entries: ReadonlyArray<HostReportEntry>): string {
  if (entries.length === 0) return "HOSTS: no hosts configured to probe.";
  const s = summarizeHostReport(entries);
  const headline =
    s.unreachable.length > 0
      ? `HOSTS: ${s.unreachable.length} of ${entries.length} UNREACHABLE (${s.unreachable.join(", ")}) — that is not an all-clear.`
      : s.pressured.length > 0
        ? `HOSTS: ${s.pressured.length} of ${entries.length} under pressure (${s.pressured.join(", ")}).`
        : `HOSTS: all ${entries.length} healthy.`;
  return [headline, ...entries.map(renderEntry)].join("\n");
}
