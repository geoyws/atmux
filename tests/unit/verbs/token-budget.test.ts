// Unit tests for src/verbs/token-budget.ts — ADR-273 §Supplement.
//
// Covers the IO half core cannot: argv parsing, probe-script discovery,
// the argv handed to the probe, the failure path when the probe cannot
// run, and the exit code. Nothing here spawns a subprocess or touches
// the filesystem — `runProbe` and `exists` are injected.

import { describe, expect, test } from "bun:test";
import { REDACTED } from "../../../src/core/vox/token-budget.ts";
import { ConfigError, UsageError } from "../../../src/errors.ts";
import {
  budgetProbeArgv,
  budgetProbeCandidates,
  DEFAULT_BUDGET_PROBE_TIMEOUT_MS,
  isBudgetProvider,
  parseTokenBudgetArgs,
  probeFailureMessage,
  resolveBudgetProbeTimeoutMs,
  tokenBudget,
} from "../../../src/verbs/token-budget.ts";

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

function capture(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

/** Base deps: the probe script exists, the clock is frozen. */
function deps(over: Parameters<typeof tokenBudget>[1] = {}) {
  return {
    exists: async () => true,
    nowSec: () => NOW,
    env: { HOME: "/home/g" },
    ...over,
  };
}

// ---------- Parsing ----------

describe("parseTokenBudgetArgs", () => {
  test("defaults: every provider, live, human output", () => {
    expect(parseTokenBudgetArgs([])).toEqual({
      provider: "all",
      cacheOnly: false,
      json: false,
    });
  });

  test("all flags parse together", () => {
    expect(parseTokenBudgetArgs(["--provider", "claude", "--cache-only", "--json"])).toEqual({
      provider: "claude",
      cacheOnly: true,
      json: true,
    });
  });

  test("--provider without a value is a UsageError", () => {
    expect(() => parseTokenBudgetArgs(["--provider"])).toThrow(/--provider requires a value/);
  });

  test("an unknown flag is refused", () => {
    expect(() => parseTokenBudgetArgs(["--yolo"])).toThrow(/unknown flag: --yolo/);
  });

  test.each([["abc"], ["0"], ["-1"]])("--timeout-ms %p is refused", (bad) => {
    expect(() => parseTokenBudgetArgs(["--timeout-ms", bad])).toThrow(
      /--timeout-ms must be a positive number/,
    );
  });

  test("the PARSER carries a dash-led provider value through as data", () => {
    // The catalog's flag-value safety claim rests on this. Value
    // legality is the verb's job (see the next block), not the
    // parser's, exactly as `parseNudgeArgs` splits `--action`.
    expect(parseTokenBudgetArgs(["--provider", "--team-dir"]).provider).toBe("--team-dir");
    expect(parseTokenBudgetArgs(["--provider", "--no-ping"]).provider).toBe("--no-ping");
  });
});

describe("isBudgetProvider", () => {
  test.each([["all"], ["codex"], ["claude"], ["zai"], ["kimi"]])("%p is accepted", (p) => {
    expect(isBudgetProvider(p)).toBe(true);
  });

  test.each([["openai"], ["--team-dir"], [""], ["Claude"]])("%p is rejected", (p) => {
    expect(isBudgetProvider(p)).toBe(false);
  });
});

describe("tokenBudget — the allow-list gate runs in the VERB", () => {
  test("an out-of-list provider is refused before the probe runs", async () => {
    let ran = false;
    await expect(
      tokenBudget(
        ["--provider", "openai"],
        deps({
          runProbe: async () => {
            ran = true;
            return "";
          },
        }),
      ),
    ).rejects.toThrow(UsageError);
    expect(ran).toBe(false);
  });

  test("a dash-led provider is refused as a bad VALUE, naming the legal set", async () => {
    await expect(
      tokenBudget(["--provider", "--team-dir"], deps({ runProbe: async () => "" })),
    ).rejects.toThrow(/unknown provider "--team-dir"/);
  });
});

// ---------- Probe discovery ----------

describe("budgetProbeCandidates", () => {
  test("ATMUX_BUDGET_PROBE wins outright", () => {
    expect(budgetProbeCandidates({ ATMUX_BUDGET_PROBE: "/opt/p.sh", HOME: "/home/g" })).toEqual([
      "/opt/p.sh",
    ]);
  });

  test("the shared agents skills root is tried FIRST", () => {
    // ~/.agents/skills is the one tree both Claude and Codex read; the
    // .claude* paths are per-account symlinks into it.
    const c = budgetProbeCandidates({ HOME: "/home/g" });
    expect(c[0]).toBe("/home/g/.agents/skills/budget/scripts/probe-budgets.sh");
    expect(c).toContain("/home/g/.claude/skills/budget/scripts/probe-budgets.sh");
    expect(c).toContain("/home/g/.claude-gmail/skills/budget/scripts/probe-budgets.sh");
  });

  test("no HOME → no candidates, rather than a bare relative path", () => {
    expect(budgetProbeCandidates({})).toEqual([]);
  });

  test("an empty ATMUX_BUDGET_PROBE falls back to the search list", () => {
    expect(budgetProbeCandidates({ ATMUX_BUDGET_PROBE: "  ", HOME: "/home/g" })).toHaveLength(3);
  });
});

describe("tokenBudget — script resolution", () => {
  test("the FIRST existing candidate is used", async () => {
    const seen: string[] = [];
    let used = "";
    await tokenBudget(
      [],
      deps({
        exists: async (p) => {
          seen.push(p);
          return p.includes(".claude/");
        },
        runProbe: async (script) => {
          used = script;
          return HEALTHY_NDJSON;
        },
        log: capture().log,
      }),
    );
    expect(used).toBe("/home/g/.claude/skills/budget/scripts/probe-budgets.sh");
    // It stopped looking once it found one.
    expect(seen).toEqual([
      "/home/g/.agents/skills/budget/scripts/probe-budgets.sh",
      "/home/g/.claude/skills/budget/scripts/probe-budgets.sh",
    ]);
  });

  test("no probe anywhere → ConfigError naming where it looked", async () => {
    await expect(
      tokenBudget([], deps({ exists: async () => false, runProbe: async () => "" })),
    ).rejects.toThrow(ConfigError);
    await expect(
      tokenBudget([], deps({ exists: async () => false, runProbe: async () => "" })),
    ).rejects.toThrow(/ATMUX_BUDGET_PROBE/);
  });
});

describe("budgetProbeArgv", () => {
  test("always asks for JSON and names the provider", () => {
    expect(budgetProbeArgv({ provider: "claude", cacheOnly: false, json: false })).toEqual([
      "--json",
      "--provider",
      "claude",
    ]);
  });

  test("--cache-only is added only when asked for", () => {
    expect(budgetProbeArgv({ provider: "all", cacheOnly: true, json: true })).toEqual([
      "--json",
      "--provider",
      "all",
      "--cache-only",
    ]);
  });

  test("the probe is never asked to refresh credentials implicitly", () => {
    // A voice read must not rotate a refreshToken behind a live TUI's
    // back (the ADR-078 race). No flag here may imply a write.
    const argv = budgetProbeArgv({ provider: "all", cacheOnly: false, json: false });
    for (const forbidden of ["--refresh", "--force", "--write"]) {
      expect(argv).not.toContain(forbidden);
    }
  });
});

// ---------- Timeout ----------

describe("resolveBudgetProbeTimeoutMs", () => {
  test("default when unset", () => {
    expect(resolveBudgetProbeTimeoutMs({})).toBe(DEFAULT_BUDGET_PROBE_TIMEOUT_MS);
  });

  test("honours a valid override", () => {
    expect(resolveBudgetProbeTimeoutMs({ ATMUX_BUDGET_PROBE_TIMEOUT_MS: "9000" })).toBe(9000);
  });

  test.each([["x"], [""], ["0"], ["-1"], ["NaN"]])("fails CLOSED on %p", (raw) => {
    expect(resolveBudgetProbeTimeoutMs({ ATMUX_BUDGET_PROBE_TIMEOUT_MS: raw })).toBe(
      DEFAULT_BUDGET_PROBE_TIMEOUT_MS,
    );
  });

  test("--timeout-ms reaches the probe runner", async () => {
    let saw = 0;
    await tokenBudget(
      ["--timeout-ms", "1234"],
      deps({
        runProbe: async (_s, _a, t) => {
          saw = t;
          return HEALTHY_NDJSON;
        },
        log: capture().log,
      }),
    );
    expect(saw).toBe(1234);
  });
});

// ---------- Exit codes + output ----------

describe("tokenBudget — bad news is a successful read; nothing readable is not", () => {
  // The bridge maps a nonzero exit to `verb_failed`, so "you are rate
  // limited" must NOT exit nonzero — it would reach the model as a
  // broken tool rather than as the answer. Nonzero is reserved for
  // "could not measure anything at all".

  test("all budgets healthy → 0", async () => {
    const c = capture();
    const code = await tokenBudget(
      [],
      deps({ runProbe: async () => HEALTHY_NDJSON, log: c.log }),
    );
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("all 1 measured budgets have headroom");
  });

  test("a rejected row still exits 0 — the report IS the answer", async () => {
    const c = capture();
    const code = await tokenBudget(
      [],
      deps({ runProbe: async () => HEALTHY_NDJSON + REJECTED_NDJSON, log: c.log }),
    );
    expect(code).toBe(0);
    // The verdict is still not-ok; it lives in the text and in --json.
    expect(c.lines.join("\n")).toContain("at capacity or unusable — not healthy");
  });

  test("the machine-readable verdict is where a shell gate reads it", async () => {
    const c = capture();
    await tokenBudget(
      ["--json"],
      deps({ runProbe: async () => HEALTHY_NDJSON + REJECTED_NDJSON, log: c.log }),
    );
    expect(JSON.parse(c.lines[0] as string).ok).toBe(false);
  });

  test("a probe that cannot run → 1 with an explicit UNKNOWN, never a silent 0", async () => {
    const c = capture();
    const code = await tokenBudget(
      [],
      deps({
        runProbe: async () => {
          throw new Error("spawn timeout after 45000ms: probe-budgets.sh");
        },
        log: c.log,
      }),
    );
    expect(code).toBe(1);
    const out = c.lines.join("\n");
    expect(out).toContain("BUDGET: UNKNOWN");
    expect(out).toContain("Treat headroom as unverified.");
    expect(out).toContain("spawn timeout after 45000ms");
  });

  test("malformed probe output → 1 — nothing was measured, so it IS a failure", async () => {
    const c = capture();
    const code = await tokenBudget(
      [],
      deps({ runProbe: async () => "not json\nalso not json\n", log: c.log }),
    );
    expect(code).toBe(1);
    expect(c.lines.join("\n")).toContain("the probe emitted 2 unreadable line(s)");
  });

  test("a probe that exits clean with NO rows → 1, not a false all-clear", async () => {
    const c = capture();
    const code = await tokenBudget([], deps({ runProbe: async () => "", log: c.log }));
    expect(code).toBe(1);
    expect(c.lines.join("\n")).toContain("the probe returned no rows");
  });
});

describe("tokenBudget — --json", () => {
  test("carries the verdict, summary and rows", async () => {
    const c = capture();
    await tokenBudget(
      ["--json"],
      deps({ runProbe: async () => HEALTHY_NDJSON + REJECTED_NDJSON, log: c.log }),
    );
    const parsed = JSON.parse(c.lines[0] as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.summary.lost).toBe(1);
    expect(parsed.summary.okCount).toBe(1);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[1].status).toBe("rejected");
  });

  test("CONTROL: a benign note survives into the JSON", async () => {
    // Proves the JSON path actually carries `note`, so the redaction
    // assertion below cannot pass merely because the field was dropped.
    const c = capture();
    await tokenBudget(["--json"], deps({ runProbe: async () => REJECTED_NDJSON, log: c.log }));
    expect(c.lines[0]).toContain("rate_limit_reached");
  });

  test("a credential planted in a row is masked in the JSON output too", async () => {
    // A leak that only happens under a flag is still a leak.
    const planted = "sk-ant-oat01-CAFEBABECAFEBABECAFEBABECAFEBABE";
    const c = capture();
    await tokenBudget(
      ["--json"],
      deps({
        runProbe: async () =>
          JSON.stringify({
            provider: "claude",
            account: "gmail",
            bucket: "5h",
            usedPercent: null,
            windowMinutes: null,
            resetsAt: null,
            status: "error:token_invalid",
            source: "live",
            observedAt: NOW,
            note: `refresh failed for ${planted}`,
          }),
        log: c.log,
      }),
    );
    const out = c.lines[0] as string;
    expect(out).not.toContain(planted);
    expect(out).not.toContain("CAFEBABE");
    expect(out).toContain(REDACTED);
    // Still valid JSON after masking.
    expect(() => JSON.parse(out)).not.toThrow();
  });

  test("a probe failure under --json still emits a JSON envelope", async () => {
    const c = capture();
    const code = await tokenBudget(
      ["--json"],
      deps({
        runProbe: async () => {
          throw new Error("boom");
        },
        log: c.log,
      }),
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.lines[0] as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("BUDGET: UNKNOWN");
    expect(parsed.rows).toEqual([]);
  });
});

describe("probeFailureMessage", () => {
  test("names the failure and refuses to imply headroom", () => {
    const out = probeFailureMessage("curl: (28) Operation timed out");
    expect(out).toContain("BUDGET: UNKNOWN");
    expect(out).toContain("curl: (28) Operation timed out");
    expect(out).toContain("Treat headroom as unverified.");
  });

  test("empty stderr still produces an honest message", () => {
    expect(probeFailureMessage("   ")).toContain("no detail");
  });

  test("CONTROL: ordinary stderr text passes through verbatim", () => {
    // Without this, the redaction assertion below would be satisfied by
    // a function that simply discarded its input.
    expect(probeFailureMessage("missing dependency: jq")).toContain("missing dependency: jq");
  });

  test("a credential in stderr is REDACTED before it is spoken or logged", () => {
    const planted = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    const out = probeFailureMessage(`auth failed: ${planted}`);
    expect(out).not.toContain(planted);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).toContain(REDACTED);
    expect(out).toContain("auth failed:");
  });

  test("only the last few stderr lines are surfaced, so a dump is not spoken", () => {
    const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const out = probeFailureMessage(many);
    expect(out).toContain("line19");
    expect(out).not.toContain("line0 ");
    expect(out).not.toContain("line5");
  });
});
