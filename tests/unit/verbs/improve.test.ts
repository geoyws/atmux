// Unit tests for src/verbs/improve.ts (ADR-052 T1).
// T4 owns full-coverage; this file ships the AC-stub set per ADR-052 T1
// scope: parseImproveArgs, --status, --dry-run, --budget write,
// idempotence-skip on second invocation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../../../src/errors.ts";
import { improve, parseImproveArgs } from "../../../src/verbs/improve.ts";

let teamDir: string;
let atmuxDir: string;

beforeEach(async () => {
  teamDir = await mkdtemp(join(tmpdir(), "atmux-improve-verb-"));
  atmuxDir = join(teamDir, ".atmux");
  await mkdir(join(atmuxDir, "state"), { recursive: true });
  await writeFile(
    join(atmuxDir, "team.json"),
    JSON.stringify({ name: "smoke", members: [{ name: "alpha" }] }),
  );
});

afterEach(async () => {
  await rm(teamDir, { recursive: true, force: true });
});

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ out: string; result: T }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    out += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { out, result };
  } finally {
    process.stdout.write = orig;
  }
}

// ---------- parseImproveArgs ----------

describe("parseImproveArgs", () => {
  test("defaults — all flags false, no budget", () => {
    expect(parseImproveArgs([])).toEqual({
      status: false,
      tick: false,
      dryRun: false,
      defaultBudget: false,
      idleFallback: false,
      force: false,
    });
  });

  test("--budget <spec>", () => {
    expect(parseImproveArgs(["--budget", "30%-wk"])).toEqual({
      status: false,
      tick: false,
      dryRun: false,
      defaultBudget: false,
      idleFallback: false,
      force: false,
      budget: "30%-wk",
    });
  });

  test("--tick parses to tick:true", () => {
    expect(parseImproveArgs(["--tick"]).tick).toBe(true);
  });

  test("all flags", () => {
    const got = parseImproveArgs([
      "--status",
      "--dry-run",
      "--default-budget",
      "--idle-fallback",
      "--force",
    ]);
    expect(got.status).toBe(true);
    expect(got.dryRun).toBe(true);
    expect(got.defaultBudget).toBe(true);
    expect(got.idleFallback).toBe(true);
    expect(got.force).toBe(true);
  });

  test("--budget without value throws", () => {
    expect(() => parseImproveArgs(["--budget"])).toThrow(UsageError);
  });

  test("--team-dir without value throws (covers verb.ts:103)", () => {
    expect(() => parseImproveArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("--team-dir with value parses through", () => {
    const got = parseImproveArgs(["--team-dir", "/tmp/foo"]);
    expect(got.teamDir).toBe("/tmp/foo");
  });

  test("unknown arg throws", () => {
    expect(() => parseImproveArgs(["--bogus"])).toThrow(UsageError);
  });

  test("each variant of --budget value passes through verbatim", () => {
    expect(parseImproveArgs(["--budget", "1000000"]).budget).toBe("1000000");
    expect(parseImproveArgs(["--budget", "30%"]).budget).toBe("30%");
    expect(parseImproveArgs(["--budget", "30%-5h"]).budget).toBe("30%-5h");
    expect(parseImproveArgs(["--budget", "30%-wk"]).budget).toBe("30%-wk");
  });

  test("flag bundles in any order produce equivalent parsed output", () => {
    const a = parseImproveArgs(["--budget", "1000000", "--idle-fallback", "--force"]);
    const b = parseImproveArgs(["--force", "--idle-fallback", "--budget", "1000000"]);
    expect(a).toEqual(b);
  });
});

// ---------- --status read path ----------

describe("improve --status", () => {
  test("missing state file → emits {} JSON, exit 0", async () => {
    const { out, result } = await captureStdout(() => improve(["--status", "--team-dir", teamDir]));
    expect(result).toBe(0);
    expect(out.trim()).toBe("{}");
  });

  test("existing state file → emits its JSON, exit 0", async () => {
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const sample = {
      active: true,
      runId: "ei-deadbeef",
      startedAt: 1778080000,
      mode: "user-invoked",
      budgetSpec: "1000000",
      budgetTotal: 1000000,
      budgetRemaining: 1000000,
      cycleN: 0,
      currentCycle: null,
      lastCycleClosedAt: null,
      history: [],
    };
    await writeFile(path, `${JSON.stringify(sample)}\n`);
    const { out, result } = await captureStdout(() => improve(["--status", "--team-dir", teamDir]));
    expect(result).toBe(0);
    expect(JSON.parse(out)).toEqual(sample);
  });
});

// ---------- --dry-run ----------

describe("improve --dry-run", () => {
  test("--budget <int> --dry-run → prints formula + state path, no writes", async () => {
    const { out, result } = await captureStdout(() =>
      improve(["--dry-run", "--budget", "1000000", "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(out).toContain("dry-run");
    expect(out).toContain("spec:    1000000");
    expect(out).toContain("formula: raw=1000000");
    expect(out).toContain("total:   1000000 tokens");
    expect(out).toContain("eternal-improvement.json");
    // No state file written.
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("default 30%-wk + no probe → fail-closed UsageError", async () => {
    await expect(improve(["--dry-run", "--team-dir", teamDir])).rejects.toThrow(UsageError);
  });

  test("invalid budget spec → UsageError (covers verb.ts:176-179)", async () => {
    await expect(
      improve(["--dry-run", "--budget", "not-a-spec", "--team-dir", teamDir]),
    ).rejects.toThrow(UsageError);
  });

  test("--budget 30%-wk --dry-run with mocked probe → resolves + prints formula", async () => {
    // Land a probe so the pct-* path doesn't fail-closed.
    const { writeFile } = await import("node:fs/promises");
    const probePath = join(atmuxDir, "state", "budget-probe-smoke.json");
    await writeFile(probePath, JSON.stringify({ wk_util: 0 }));
    const { out, result } = await captureStdout(() =>
      improve(["--dry-run", "--budget", "30%-wk", "--team-dir", teamDir]),
    );
    expect(result).toBe(0);
    expect(out).toContain("30%-wk");
    expect(out).toContain("wk_util=0.00");
  });
});

// ---------- --budget write path ----------

describe("improve --budget", () => {
  test("first invocation writes state-file with the budget total + opens cycle 1", async () => {
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir]);
    expect(exit).toBe(0);
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const got = JSON.parse(await readFile(path, "utf8"));
    expect(got.active).toBe(true);
    expect(got.budgetTotal).toBe(1000000);
    expect(got.budgetRemaining).toBe(1000000);
    expect(got.budgetSpec).toBe("1000000");
    expect(got.mode).toBe("user-invoked");
    // ADR-052 T7: invocation opens cycle 1 immediately (cycleN 0 → 1).
    expect(got.cycleN).toBe(1);
    expect(got.currentCycle).not.toBeNull();
    expect(got.currentCycle.tasksLanded).toEqual([]);
    expect(got.currentCycle.tasksDispatched).toEqual([]);
    expect(got.currentCycle.tasksDone).toEqual([]);
    expect(got.currentCycle.tokensSpent).toBe(0);
    expect(got.runId).toMatch(/^ei-[0-9a-f]{8}$/);
  });

  test("first invocation appends arm directive to .atmux/improve-directives.md", async () => {
    await improve(["--budget", "1000000", "--team-dir", teamDir]);
    const directivesPath = join(atmuxDir, "improve-directives.md");
    const text = await readFile(directivesPath, "utf8");
    expect(text).toContain("Improve Directives");
    expect(text).toContain("cycle 1 requested");
    expect(text).toContain("ask each lane member");
  });

  test("--idle-fallback flips mode", async () => {
    await improve(["--budget", "1000000", "--idle-fallback", "--team-dir", teamDir]);
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const got = JSON.parse(await readFile(path, "utf8"));
    expect(got.mode).toBe("idle-fallback");
  });
});

// ---------- Idempotence ----------

describe("improve idempotence", () => {
  test("second invocation while active → exit 0 + state unchanged", async () => {
    await improve(["--budget", "1000000", "--team-dir", teamDir]);
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const before = await readFile(path, "utf8");

    // Capture stderr to confirm the "already active" log line.
    let err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      err += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = await improve(["--budget", "1000000", "--team-dir", teamDir]);
      expect(exit).toBe(0);
    } finally {
      process.stderr.write = origErr;
    }
    expect(err).toContain("already active");
    expect(err).toContain("--force");

    const after = await readFile(path, "utf8");
    expect(after).toBe(before);
  });

  test("--force overrides idempotence", async () => {
    await improve(["--budget", "1000000", "--team-dir", teamDir]);
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const before = JSON.parse(await readFile(path, "utf8"));
    const exit = await improve(["--budget", "1000000", "--force", "--team-dir", teamDir]);
    expect(exit).toBe(0);
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.runId).not.toBe(before.runId);
  });

  test("stale run (>24h + >6h since last cycle) clears with stderr log + new run starts (covers verb.ts:217-219)", async () => {
    // Hand-craft a stale state-file directly to bypass the active guard.
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    // 30h ago, no current cycle → stale per ADR-052 §Idempotence.
    const staleStartedAt = Math.floor(Date.now() / 1000) - 30 * 60 * 60;
    const staleState = {
      active: true,
      runId: "ei-staleeee",
      startedAt: staleStartedAt,
      mode: "user-invoked",
      budgetSpec: "1000000",
      budgetTotal: 1000000,
      budgetRemaining: 1000000,
      cycleN: 0,
      currentCycle: null,
      lastCycleClosedAt: null,
      history: [],
    };
    await writeFile(path, `${JSON.stringify(staleState)}\n`);

    let err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      err += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      const exit = await improve(["--budget", "2000000", "--team-dir", teamDir]);
      expect(exit).toBe(0);
    } finally {
      process.stderr.write = origErr;
    }
    expect(err).toContain("stale improvement run");

    // New run took over — runId rotated, budget refreshed.
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.runId).not.toBe("ei-staleeee");
    expect(after.budgetTotal).toBe(2000000);
    expect(after.active).toBe(true);
  });
});

// ---------- ImproveOpts test injection (clock + runId + stdio) ----------

describe("improve — ImproveOpts injection", () => {
  test("nowMs override pins startedAt deterministically", async () => {
    const fixed = 1_777_777_777_000; // ms
    await improve(["--budget", "1000000", "--team-dir", teamDir], {
      nowMs: () => fixed,
    });
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const got = JSON.parse(await readFile(path, "utf8"));
    expect(got.startedAt).toBe(Math.floor(fixed / 1000));
  });

  test("runIdFactory override pins runId deterministically", async () => {
    await improve(["--budget", "1000000", "--team-dir", teamDir], {
      runIdFactory: () => "ei-abcd1234",
    });
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const got = JSON.parse(await readFile(path, "utf8"));
    expect(got.runId).toBe("ei-abcd1234");
  });

  test("env injection writes a budgetSpec sourced from ATMUX_IMPROVE_BUDGET", async () => {
    await improve(["--team-dir", teamDir], {
      env: { ATMUX_IMPROVE_BUDGET: "750000" },
    });
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const got = JSON.parse(await readFile(path, "utf8"));
    expect(got.budgetSpec).toBe("750000");
    expect(got.budgetTotal).toBe(750000);
  });

  test("stdout/stderr injection captures output without monkey-patching globals", async () => {
    let captured = "";
    await improve(["--status", "--team-dir", teamDir], {
      stdout: (s) => {
        captured += s;
        return true;
      },
    });
    expect(captured.trim()).toBe("{}");
  });
});

// ---------- requireTeam gate ----------

describe("improve — team.json gate", () => {
  test("missing team.json → ConfigError (verb refuses outside a team root)", async () => {
    const { rm: _rm } = await import("node:fs/promises");
    await _rm(join(atmuxDir, "team.json"));
    await expect(improve(["--status", "--team-dir", teamDir])).rejects.toThrow();
  });
});

// ---------- Discord ping (T3 placeholder) ----------

describe("improve — Discord ping gate", () => {
  test("ATMUX_DISCORD_TRIGGER set to 'eternal-improvement-start' runs ping path (no-op today)", async () => {
    // T1 ships the firePingIfWired no-op; T3 lands the actual send.
    // Ensure the trigger-set branch executes without throwing.
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      env: { ATMUX_DISCORD_TRIGGER: "eternal-improvement-start" },
    });
    expect(exit).toBe(0);
  });

  test("ATMUX_DISCORD_TRIGGER unset → ping path is skipped (no error)", async () => {
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      env: {},
    });
    expect(exit).toBe(0);
  });

  test("ATMUX_DISCORD_TRIGGER set to a different value → ping skipped", async () => {
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      env: { ATMUX_DISCORD_TRIGGER: "whip-progress" },
    });
    expect(exit).toBe(0);
  });
});

// ---------- Discord soft-degrade (regression — t-bf6aeb39 / t-263fd3b5) ----------
//
// HTTP 429 rate-limits from concurrent test runs (or production webhook
// outages) used to leak out of `firePingStart` and exit `atmux improve`
// non-zero. The `safeFireDiscord` wrapper swallows ANY send error
// (ConfigError, DiscordWebhookError, network) + warns on stderr instead.
// Lock the property: a throwing discordSend stub → verb still exit 0 + a
// single WARN line on stderr.

describe("improve — Discord soft-degrade on send failure (t-bf6aeb39)", () => {
  test("discordSend throws ConfigError (missing webhook) → exit 0 + stderr WARN", async () => {
    const stderrChunks: string[] = [];
    const throwingDiscord = async () => {
      throw new Error("no Discord webhook resolved (hint: set ATMUX_DISCORD_WEBHOOK)");
    };
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      discordSend: throwingDiscord as never,
      stderr: (s) => {
        stderrChunks.push(s);
        return true;
      },
    });
    expect(exit).toBe(0);
    expect(stderrChunks.join("")).toContain("discord ping eternal-improvement-start skipped");
    expect(stderrChunks.join("")).toContain("no Discord webhook resolved");
  });

  test("discordSend throws DiscordWebhookError-shaped (HTTP 429) → exit 0 + stderr WARN", async () => {
    const stderrChunks: string[] = [];
    const throwingDiscord = async () => {
      throw new Error(
        "discord webhook eternal-improvement-start failed (HTTP 429): direct-fetch non-2xx",
      );
    };
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      discordSend: throwingDiscord as never,
      stderr: (s) => {
        stderrChunks.push(s);
        return true;
      },
    });
    expect(exit).toBe(0);
    expect(stderrChunks.join("")).toContain("discord ping eternal-improvement-start skipped");
    expect(stderrChunks.join("")).toContain("HTTP 429");
  });

  test("non-Error throw (string) → swallowed + WARN includes the string", async () => {
    const stderrChunks: string[] = [];
    const throwingDiscord = async () => {
      throw "plain string failure";
    };
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir], {
      discordSend: throwingDiscord as never,
      stderr: (s) => {
        stderrChunks.push(s);
        return true;
      },
    });
    expect(exit).toBe(0);
    expect(stderrChunks.join("")).toContain("plain string failure");
  });
});

// ---------- --tick (ADR-052 T7) ----------

describe("improve --tick", () => {
  /** Build a kanban.json that the verb can read. */
  async function seedKanban(tasks: Array<Record<string, unknown>>) {
    const kanbanPath = join(atmuxDir, "kanban.json");
    await writeFile(kanbanPath, JSON.stringify({ tasks, epics: [], stories: [] }));
  }

  /** Seed a fresh-armed state file (cycle 1 open, no dispatched tasks). */
  async function seedActiveCycle(overrides?: Record<string, unknown>) {
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const state = {
      active: true,
      runId: "ei-tickrun1",
      startedAt: 1_800_000_000,
      mode: "user-invoked",
      budgetSpec: "1000000",
      budgetTotal: 1_000_000,
      budgetRemaining: 1_000_000,
      cycleN: 1,
      currentCycle: {
        startedAt: 1_800_000_010,
        tasksLanded: ["t-aaaaaaaa"],
        tasksDispatched: ["t-aaaaaaaa"],
        tasksDone: ["t-aaaaaaaa"],
        tokensSpent: 0,
      },
      lastCycleClosedAt: null,
      history: [],
      ...overrides,
    };
    await writeFile(path, JSON.stringify(state));
    return state;
  }

  test("missing state file → no-op exit 0", async () => {
    await seedKanban([]);
    const exit = await improve(["--tick", "--team-dir", teamDir]);
    expect(exit).toBe(0);
  });

  test("active=false → no-op exit 0 (run already terminated)", async () => {
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    await writeFile(
      path,
      JSON.stringify({
        active: false,
        runId: "ei-deadrun",
        startedAt: 1,
        mode: "user-invoked",
        budgetSpec: "1000000",
        budgetTotal: 1_000_000,
        budgetRemaining: 0,
        cycleN: 0,
        currentCycle: null,
        lastCycleClosedAt: null,
        history: [],
      }),
    );
    await seedKanban([]);
    const exit = await improve(["--tick", "--team-dir", teamDir]);
    expect(exit).toBe(0);
  });

  test("currentCycle null → no-op (nothing to tick)", async () => {
    await seedActiveCycle({ currentCycle: null });
    await seedKanban([]);
    const exit = await improve(["--tick", "--team-dir", teamDir]);
    expect(exit).toBe(0);
  });

  test("driver Task in-progress → cycle pauses", async () => {
    await seedActiveCycle();
    await seedKanban([{ id: "t-driver", status: "in-progress", epic: null }]);
    let stderrCaptured = "";
    const exit = await improve(["--tick", "--team-dir", teamDir], {
      stderr: (s) => {
        stderrCaptured += s;
        return true;
      },
    });
    expect(exit).toBe(0);
    expect(stderrCaptured).toContain("driver Task in-flight");
    const after = JSON.parse(
      await readFile(join(atmuxDir, "state", "eternal-improvement.json"), "utf8"),
    );
    expect(after.currentCycle.paused).toBe(true);
  });

  test("dispatched task not yet done → no close, state unchanged", async () => {
    await seedActiveCycle();
    await seedKanban([
      { id: "t-aaaaaaaa", status: "in-progress", epic: "e-a25968cc", completedAt: null },
    ]);
    const before = await readFile(join(atmuxDir, "state", "eternal-improvement.json"), "utf8");
    const exit = await improve(["--tick", "--team-dir", teamDir]);
    expect(exit).toBe(0);
    const after = await readFile(join(atmuxDir, "state", "eternal-improvement.json"), "utf8");
    expect(after).toBe(before);
  });

  test("all dispatched tasks done + committed → cycle closes + re-arms", async () => {
    await seedActiveCycle();
    await seedKanban([
      {
        id: "t-aaaaaaaa",
        status: "done",
        epic: "e-a25968cc",
        completedAt: 1_800_000_500,
      },
    ]);
    const sent: unknown[] = [];
    const exit = await improve(["--tick", "--team-dir", teamDir], {
      discordSend: (async (opts: unknown) => {
        sent.push(opts);
      }) as never,
      tokensSpentForClose: async () => 5_000,
      nowMs: () => 1_800_001_000_000,
    });
    expect(exit).toBe(0);
    const after = JSON.parse(
      await readFile(join(atmuxDir, "state", "eternal-improvement.json"), "utf8"),
    );
    // Cycle 1 closed → cycle 2 opened.
    expect(after.cycleN).toBe(2);
    expect(after.currentCycle).not.toBeNull();
    // History got the closed cycle.
    expect(after.history).toHaveLength(1);
    expect(after.history[0].cycleN).toBe(1);
    expect(after.history[0].tasksDone).toBe(1);
    expect(after.history[0].tokensSpent).toBe(5_000);
    // Budget decremented.
    expect(after.budgetRemaining).toBe(995_000);
    // Two pings sent: progress (close) + start (re-arm).
    expect(sent).toHaveLength(2);
    // Directive file got the re-arm entry.
    const directives = await readFile(join(atmuxDir, "improve-directives.md"), "utf8");
    expect(directives).toContain("cycle 2 requested");
  });

  test("budget exhaustion at close → terminate (active:false, done ping, onTerminate fires)", async () => {
    await seedActiveCycle({ budgetRemaining: 5_000 });
    await seedKanban([
      {
        id: "t-aaaaaaaa",
        status: "done",
        epic: "e-a25968cc",
        completedAt: 1_800_000_500,
      },
    ]);
    const sent: Array<Record<string, unknown>> = [];
    let onTerminateFired = false;
    const exit = await improve(["--tick", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      tokensSpentForClose: async () => 10_000, // pushes remaining negative
      onTerminate: async () => {
        onTerminateFired = true;
      },
      nowMs: () => 1_800_001_000_000,
    });
    expect(exit).toBe(0);
    const after = JSON.parse(
      await readFile(join(atmuxDir, "state", "eternal-improvement.json"), "utf8"),
    );
    expect(after.active).toBe(false);
    expect(after.budgetRemaining).toBeLessThan(0); // overage
    expect(onTerminateFired).toBe(true);
    // Two pings: progress + done.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.template).toBe("eternal-improvement-done");
  });

  test("Mode B (idle-fallback) → done ping carries modeB:true", async () => {
    await seedActiveCycle({
      mode: "idle-fallback",
      budgetRemaining: 1_000,
    });
    await seedKanban([
      {
        id: "t-aaaaaaaa",
        status: "done",
        epic: "e-a25968cc",
        completedAt: 1_800_000_500,
      },
    ]);
    const sent: Array<Record<string, unknown>> = [];
    await improve(["--tick", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
      tokensSpentForClose: async () => 5_000,
      nowMs: () => 1_800_001_000_000,
    });
    const doneOpts = sent.find((s) => s.template === "eternal-improvement-done");
    expect(doneOpts).toBeDefined();
    // The render renders modeB:true into a "🛑 (Mode B) team will now `atmux stop`" bullet.
    const bullets = (doneOpts?.bullets as string[]) ?? [];
    expect(bullets.some((b) => b.includes("Mode B"))).toBe(true);
  });

  test("driver preempt + already-paused cycle → no second pause-write", async () => {
    await seedActiveCycle({
      currentCycle: {
        startedAt: 1_800_000_010,
        tasksLanded: ["t-aaaaaaaa"],
        tasksDispatched: ["t-aaaaaaaa"],
        tasksDone: ["t-aaaaaaaa"],
        tokensSpent: 0,
        paused: true,
      },
    });
    await seedKanban([{ id: "t-driver", status: "in-progress", epic: null }]);
    let stderrCaptured = "";
    const exit = await improve(["--tick", "--team-dir", teamDir], {
      stderr: (s) => {
        stderrCaptured += s;
        return true;
      },
    });
    expect(exit).toBe(0);
    // Already paused — verb does NOT re-emit the pause log line.
    expect(stderrCaptured).not.toContain("driver Task in-flight");
  });
});

// ---------- Discord pings on initial arm ----------

describe("improve initial arm — Discord pings", () => {
  test("fires 🌱 [eternal-improvement-start] with rendered template", async () => {
    const sent: Array<Record<string, unknown>> = [];
    await improve(["--budget", "1000000", "--team-dir", teamDir], {
      discordSend: (async (opts: Record<string, unknown>) => {
        sent.push(opts);
      }) as never,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.template).toBe("eternal-improvement-start");
    expect(sent[0]?.team).toBe("smoke");
    const bullets = sent[0]?.bullets as string[];
    expect(bullets.some((b) => b.includes("budget:"))).toBe(true);
    expect(bullets.some((b) => b.includes("mode: user-invoked"))).toBe(true);
    expect(bullets.some((b) => b.includes("runId:"))).toBe(true);
  });
});

// ---------- buildInitialState — history carry-forward ----------

describe("improve — history carry-forward on re-arm after stale", () => {
  test("prior history entries are carried into the new run's state", async () => {
    // Seed a stale state with history entries.
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const staleStartedAt = Math.floor(Date.now() / 1000) - 30 * 60 * 60;
    const seeded = {
      active: true,
      runId: "ei-priorrun",
      startedAt: staleStartedAt,
      mode: "user-invoked",
      budgetSpec: "1000000",
      budgetTotal: 1000000,
      budgetRemaining: 0,
      cycleN: 3,
      currentCycle: null,
      lastCycleClosedAt: staleStartedAt + 3600,
      history: [
        { cycleN: 1, startedAt: 1, closedAt: 2, tasksLanded: 1, tasksDone: 1, tokensSpent: 100 },
        { cycleN: 2, startedAt: 3, closedAt: 4, tasksLanded: 2, tasksDone: 2, tokensSpent: 200 },
      ],
    };
    await writeFile(path, `${JSON.stringify(seeded)}\n`);

    // Re-arm; stale clear path executes; history should carry.
    let _err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      _err += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
    try {
      await improve(["--budget", "500000", "--team-dir", teamDir]);
    } finally {
      process.stderr.write = origErr;
    }

    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.history).toHaveLength(2);
    expect(after.history[0].cycleN).toBe(1);
    expect(after.history[1].cycleN).toBe(2);
    // lastCycleClosedAt also carries.
    expect(after.lastCycleClosedAt).toBe(staleStartedAt + 3600);
    // Budget reset to the new run's spec.
    expect(after.budgetTotal).toBe(500000);
    expect(after.budgetRemaining).toBe(500000);
  });
});
