// The STDOUT contract for the two ADR-273 §Supplement-6 infrastructure
// tools — `atmux host-pressure` and `atmux token-budget`.
//
// ---------------------------------------------------------------------
// Why this file exists, and why it is not paranoia
// ---------------------------------------------------------------------
//
// `captureVerbRun` (src/core/verb-capture.ts) collects a verb's output
// by patching `console.log` + `process.stdout.write`. It does NOT read
// stderr. So a verb that writes its receipt to stderr produces EMPTY
// captured stdout, and `src/core/vox/tool-bridge.ts` renders empty
// output as the error envelope `verb_output_unparseable` — "the verb
// produced no usable output".
//
// The result is the failure class this whole supplement is about: the
// verb SUCCEEDS and the model is told it FAILED. `tell_lead` has that
// shape today, and a separate lane owns the bridge-side fix.
//
// These two tools must not depend on that fix landing. Writing the
// report to stdout is the correct shape for a read tool regardless of
// what the bridge does, so the contract is pinned HERE, at the tool,
// where it is ours to keep.
//
// Implementation note: `console.log` does NOT route through
// `process.stdout.write` in Bun (verified directly, 2026-08-20), which
// is precisely why `verb-capture` patches both and why the helper below
// captures both channels rather than trusting either alone.

import { describe, expect, test } from "bun:test";
import type { HostPressureVerdict } from "../../../src/core/host-pressure.ts";
import type { HostReportEntry } from "../../../src/core/vox/host-report.ts";
import { hostPressure } from "../../../src/verbs/host-pressure.ts";
import { tokenBudget } from "../../../src/verbs/token-budget.ts";

// ---------- IO capture ----------

interface CapturedIo<T> {
  result: T;
  stdout: string;
  stderr: string;
}

/** Run `fn` with BOTH output channels captured on BOTH surfaces
 *  (`console.*` and `process.*.write`), then restore unconditionally. */
async function withCapturedIo<T>(fn: () => Promise<T>): Promise<CapturedIo<T>> {
  const realLog = console.log;
  const realError = console.error;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  console.log = (...a: unknown[]): void => {
    stdout += `${a.join(" ")}\n`;
  };
  console.error = (...a: unknown[]): void => {
    stderr += `${a.join(" ")}\n`;
  };
  process.stdout.write = (c: unknown): boolean => {
    stdout += String(c);
    return true;
  };
  process.stderr.write = (c: unknown): boolean => {
    stderr += String(c);
    return true;
  };
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** CONTROL: proves the helper can actually SEE a stderr write. Without
 *  it, every `expect(stderr).toBe("")` below would pass vacuously on a
 *  helper that captured nothing at all. */
describe("withCapturedIo (the harness itself)", () => {
  test("captures stdout and stderr separately, and restores both", async () => {
    const { stdout, stderr } = await withCapturedIo(async () => {
      console.log("to-stdout");
      console.error("to-stderr");
      process.stdout.write("raw-out");
      process.stderr.write("raw-err");
    });
    expect(stdout).toBe("to-stdout\nraw-out");
    expect(stderr).toBe("to-stderr\nraw-err");
    // Restored — a leaked patch would corrupt every later test's output.
    expect(console.log).not.toBe(undefined);
  });

  test("restores the channels even when the body throws", async () => {
    const before = console.log;
    await expect(
      withCapturedIo(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(console.log).toBe(before);
  });
});

// ---------- Fixtures ----------

const OK_VERDICT: HostPressureVerdict = {
  ok: true,
  reasons: [],
  probe: {
    loadAvg1min: 2,
    loadAvg15min: 3,
    memAvailableMb: 32768,
    memTotalMb: 65536,
    cpuCores: 16,
    disks: [{ mount: "/", totalMb: 447000, availableMb: 100000, usedPercent: 47 }],
    missingMounts: [],
  },
  thresholds: { maxLoadRatio: 0.75, minMemMb: 8192, maxDiskPercent: 90 },
  skipped: false,
};

function healthy(host: string): HostReportEntry {
  return { host, reachable: true, verdict: OK_VERDICT, error: null, ms: 5 };
}

function down(host: string, why: string): HostReportEntry {
  return { host, reachable: false, verdict: null, error: why, ms: 15_000 };
}

const NOW = 1_700_000_000;

const HEALTHY_NDJSON = `${JSON.stringify({
  provider: "claude",
  account: "gmail",
  bucket: "5h",
  usedPercent: 12,
  windowMinutes: 300,
  resetsAt: NOW + 3600,
  status: "allowed",
  source: "live",
  observedAt: NOW,
})}\n`;

const REJECTED_NDJSON = `${JSON.stringify({
  provider: "codex",
  account: "pro",
  bucket: "codex:primary",
  usedPercent: 100,
  windowMinutes: 10080,
  resetsAt: NOW + 7200,
  status: "rejected",
  source: "live",
  observedAt: NOW,
  note: "rate_limit_reached",
})}\n`;

function budgetDeps(runProbe: () => Promise<string>) {
  return {
    exists: async (): Promise<boolean> => true,
    nowSec: (): number => NOW,
    env: { HOME: "/home/g" },
    runProbe,
  };
}

// ---------- host_pressure ----------

describe("host-pressure — the report goes to STDOUT, never stderr", () => {
  test("a healthy report lands on stdout; stderr stays empty", async () => {
    const { result, stdout, stderr } = await withCapturedIo(() =>
      hostPressure([], { probe: async () => [healthy("hax"), healthy("hig")] }),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("HOSTS: all 2 healthy.");
    expect(stdout).toContain("hax — HEALTHY");
    // Empty stdout is what the bridge turns into
    // `verb_output_unparseable`; non-empty stdout is the whole contract.
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stderr).toBe("");
  });

  test("an UNREACHABLE report ALSO lands on stdout — the bad news must be capturable", async () => {
    // This is the case that matters most. If the unreachable report went
    // to stderr, the bridge would answer "the verb produced no usable
    // output" and the operator would never hear that hig is down.
    const { result, stdout, stderr } = await withCapturedIo(() =>
      hostPressure([], {
        probe: async () => [healthy("hax"), down("hig", "Connection refused")],
      }),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("hig — UNREACHABLE: Connection refused.");
    expect(stdout).toContain("that is not an all-clear");
    expect(stderr).toBe("");
  });

  test("--json lands on stdout and parses", async () => {
    const { stdout, stderr } = await withCapturedIo(() =>
      hostPressure(["--json"], { probe: async () => [healthy("hax")] }),
    );
    expect(JSON.parse(stdout.trim()).ok).toBe(true);
    expect(stderr).toBe("");
  });
});

// ---------- token_budget ----------

describe("token-budget — the report goes to STDOUT, never stderr", () => {
  test("a healthy report lands on stdout; stderr stays empty", async () => {
    const { result, stdout, stderr } = await withCapturedIo(() =>
      tokenBudget(
        [],
        budgetDeps(async () => HEALTHY_NDJSON),
      ),
    );
    expect(result).toBe(0);
    expect(stdout).toContain("all 1 measured budgets have headroom");
    expect(stderr).toBe("");
  });

  test("a DEGRADED report lands on stdout — 'you are rate limited' is the answer", async () => {
    const { result, stdout, stderr } = await withCapturedIo(() =>
      tokenBudget(
        [],
        budgetDeps(async () => HEALTHY_NDJSON + REJECTED_NDJSON),
      ),
    );
    // Exit 0 (a successful read of bad news) AND on stdout: both halves
    // are needed for the model to receive this as an answer rather than
    // as a tool failure.
    expect(result).toBe(0);
    expect(stdout).toContain("at capacity or unusable — not healthy");
    expect(stderr).toBe("");
  });

  test("a probe FAILURE still writes its UNKNOWN report to stdout", async () => {
    // Even the failure path must produce capturable stdout: the bridge
    // attaches `data` to the envelope, so the model can still speak
    // "budget unknown" instead of an empty error.
    const { result, stdout, stderr } = await withCapturedIo(() =>
      tokenBudget(
        [],
        budgetDeps(async () => {
          throw new Error("spawn timeout after 45000ms: probe-budgets.sh");
        }),
      ),
    );
    expect(result).toBe(1);
    expect(stdout).toContain("BUDGET: UNKNOWN");
    expect(stdout).toContain("Treat headroom as unverified.");
    expect(stderr).toBe("");
  });

  test("--json lands on stdout and parses", async () => {
    const { stdout, stderr } = await withCapturedIo(() =>
      tokenBudget(
        ["--json"],
        budgetDeps(async () => HEALTHY_NDJSON),
      ),
    );
    expect(JSON.parse(stdout.trim()).ok).toBe(true);
    expect(stderr).toBe("");
  });

  test("no credential reaches EITHER channel on the failure path", async () => {
    // The failure path is where an interpolated credential would land.
    // Asserted against both channels, not just the one we expect to use.
    const planted = "sk-ant-oat01-FEEDFACEFEEDFACEFEEDFACEFEEDFACE";
    const { stdout, stderr } = await withCapturedIo(() =>
      tokenBudget(
        [],
        budgetDeps(async () => {
          throw new Error(`auth failed: Bearer ${planted}`);
        }),
      ),
    );
    expect(stdout).not.toContain(planted);
    expect(stdout).not.toContain("FEEDFACE");
    expect(stderr).not.toContain(planted);
    // CONTROL: the surrounding prose survived, so the token was masked
    // rather than the whole message being dropped.
    expect(stdout).toContain("auth failed:");
    expect(stdout).toContain("[redacted]");
  });
});
