// Unit tests for src/verbs/host-pressure.ts — ADR-273 §Supplement.
//
// The verb's own contract, beyond what core already proves:
//   - argv parsing refuses malformed invocations rather than guessing.
//   - the EXIT CODE agrees with the report. An unreachable host exits
//     non-zero, because a probe that could not see a host has not
//     cleared it, and a 0 would let a shell `&&` chain treat a dead box
//     as a healthy one.

import { describe, expect, test } from "bun:test";
import type { HostPressureVerdict } from "../../../src/core/host-pressure.ts";
import type { HostReportEntry } from "../../../src/core/vox/host-report.ts";
import { hostPressure, parseHostPressureArgs } from "../../../src/verbs/host-pressure.ts";
import { UsageError } from "../../../src/errors.ts";

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

function pressured(host: string): HostReportEntry {
  return {
    ...healthy(host),
    verdict: { ...OK_VERDICT, ok: false, reasons: ["disk / 96% full > 90%"] },
  };
}

/** Capture stdout lines instead of writing them. */
function capture(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

// ---------- Parsing ----------

describe("parseHostPressureArgs", () => {
  test("no flags → every host, human output", () => {
    expect(parseHostPressureArgs([])).toEqual({ json: false });
  });

  test("--host restricts the report", () => {
    expect(parseHostPressureArgs(["--host", "hig"])).toEqual({ json: false, host: "hig" });
  });

  test("--json and --timeout-ms parse together", () => {
    expect(parseHostPressureArgs(["--json", "--timeout-ms", "2500"])).toEqual({
      json: true,
      timeoutMs: 2500,
    });
  });

  test("--host without a value is a UsageError, not a silent default", () => {
    expect(() => parseHostPressureArgs(["--host"])).toThrow(UsageError);
    expect(() => parseHostPressureArgs(["--host"])).toThrow(/--host requires a value/);
  });

  test.each([
    ["abc"],
    ["0"],
    ["-3"],
    ["NaN"],
  ])("--timeout-ms %p is refused rather than coerced", (bad) => {
    expect(() => parseHostPressureArgs(["--timeout-ms", bad])).toThrow(
      /--timeout-ms must be a positive number/,
    );
  });

  test("--timeout-ms without a value is a UsageError", () => {
    expect(() => parseHostPressureArgs(["--timeout-ms"])).toThrow(/requires a value/);
  });

  test("an unknown flag is refused", () => {
    expect(() => parseHostPressureArgs(["--nope"])).toThrow(/unknown flag: --nope/);
  });

  test("a dash-led value lands in the --host slot as DATA, not as a flag", () => {
    // `--host` takes argv[i+1] unconditionally, which is what makes the
    // catalog's flag-value classification safe. Pinned here against the
    // real parser rather than asserted in a comment.
    expect(parseHostPressureArgs(["--host", "--team-dir"]).host).toBe("--team-dir");
  });
});

// ---------- Exit codes ----------

describe("hostPressure — a produced report is a SUCCESSFUL read", () => {
  // The bridge maps a nonzero exit to a `verb_failed` envelope, so a
  // read verb that exits nonzero on bad news turns its own answer into a
  // tool failure. Every read verb the voice catalog wires (`health`,
  // `fleet`, `blockers`) returns 0 unconditionally; these match.

  test("every host healthy → 0", async () => {
    const c = capture();
    const code = await hostPressure([], {
      probe: async () => [healthy("hax"), healthy("hig")],
      log: c.log,
    });
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("HOSTS: all 2 healthy.");
  });

  test("an UNREACHABLE host still exits 0 — the report IS the answer", async () => {
    // If this flips to 1, the voice tool reports "hig is unreachable" to
    // the model as `verb_failed` instead of as the finding, which is the
    // single most important thing this tool can say.
    const c = capture();
    const code = await hostPressure([], {
      probe: async () => [healthy("hax"), down("hig", "Connection refused")],
      log: c.log,
    });
    expect(code).toBe(0);
    // The VERDICT is still not-ok; it just lives in the text, not the
    // exit status.
    expect(c.lines.join("\n")).toContain("UNREACHABLE");
    expect(c.lines.join("\n")).toContain("that is not an all-clear");
  });

  test("a pressured host still exits 0, with the pressure in the text", async () => {
    const c = capture();
    const code = await hostPressure([], { probe: async () => [pressured("hax")], log: c.log });
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("under pressure");
  });

  test("the machine-readable verdict is where a shell gate reads it", async () => {
    // `atmux host-pressure --json | jq -e .ok` is the supported gate now
    // that the exit status is not one.
    const c = capture();
    await hostPressure(["--json"], {
      probe: async () => [healthy("hax"), down("hig", "Connection refused")],
      log: c.log,
    });
    expect(JSON.parse(c.lines[0] as string).ok).toBe(false);
  });

  test("--host narrows the report to that host", async () => {
    const c = capture();
    // hig is down, but we asked only about hax.
    const code = await hostPressure(["--host", "hax"], {
      probe: async () => [healthy("hax"), down("hig", "Connection refused")],
      log: c.log,
    });
    expect(code).toBe(0);
    const out = c.lines.join("\n");
    expect(out).toContain("hax");
    expect(out).not.toContain("hig");
  });

  test("--host naming an unknown host fails loudly and lists the real ones", async () => {
    await expect(
      hostPressure(["--host", "nope"], {
        probe: async () => [healthy("hax"), healthy("hig")],
        log: capture().log,
      }),
    ).rejects.toThrow(/no such host: nope/);
  });
});

// ---------- Output shapes ----------

describe("hostPressure — output", () => {
  test("--json carries the verdict, the summary and every host entry", async () => {
    const c = capture();
    await hostPressure(["--json"], {
      probe: async () => [healthy("hax"), down("hig", "Connection refused")],
      log: c.log,
    });
    expect(c.lines).toHaveLength(1);
    const parsed = JSON.parse(c.lines[0] as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.summary.unreachable).toEqual(["hig"]);
    expect(parsed.summary.healthy).toEqual(["hax"]);
    // The unreachable host is PRESENT in the machine-readable output —
    // a consumer that filtered on `hosts` must still see it.
    expect(parsed.hosts.map((h: HostReportEntry) => h.host)).toEqual(["hax", "hig"]);
    expect(parsed.hosts[1].reachable).toBe(false);
    expect(parsed.hosts[1].error).toBe("Connection refused");
  });

  test("--timeout-ms is passed through to the probe", async () => {
    let sawTimeout: number | undefined;
    await hostPressure(["--timeout-ms", "3000"], {
      probe: async (deps) => {
        sawTimeout = deps?.timeoutMs;
        return [healthy("hax")];
      },
      log: capture().log,
    });
    expect(sawTimeout).toBe(3000);
  });

  test("without --timeout-ms the probe is left to resolve its own default", async () => {
    let sawTimeout: number | undefined = 999;
    await hostPressure([], {
      probe: async (deps) => {
        sawTimeout = deps?.timeoutMs;
        return [healthy("hax")];
      },
      log: capture().log,
    });
    expect(sawTimeout).toBeUndefined();
  });
});
