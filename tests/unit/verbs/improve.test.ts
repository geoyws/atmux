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
      dryRun: false,
      defaultBudget: false,
      idleFallback: false,
      force: false,
    });
  });

  test("--budget <spec>", () => {
    expect(parseImproveArgs(["--budget", "30%-wk"])).toEqual({
      status: false,
      dryRun: false,
      defaultBudget: false,
      idleFallback: false,
      force: false,
      budget: "30%-wk",
    });
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
    const a = parseImproveArgs([
      "--budget",
      "1000000",
      "--idle-fallback",
      "--force",
    ]);
    const b = parseImproveArgs([
      "--force",
      "--idle-fallback",
      "--budget",
      "1000000",
    ]);
    expect(a).toEqual(b);
  });
});

// ---------- --status read path ----------

describe("improve --status", () => {
  test("missing state file → emits {} JSON, exit 0", async () => {
    const { out, result } = await captureStdout(() =>
      improve(["--status", "--team-dir", teamDir]),
    );
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
    const { out, result } = await captureStdout(() =>
      improve(["--status", "--team-dir", teamDir]),
    );
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
  test("first invocation writes state-file with the budget total", async () => {
    const exit = await improve(["--budget", "1000000", "--team-dir", teamDir]);
    expect(exit).toBe(0);
    const path = join(atmuxDir, "state", "eternal-improvement.json");
    const got = JSON.parse(await readFile(path, "utf8"));
    expect(got.active).toBe(true);
    expect(got.budgetTotal).toBe(1000000);
    expect(got.budgetRemaining).toBe(1000000);
    expect(got.budgetSpec).toBe("1000000");
    expect(got.mode).toBe("user-invoked");
    expect(got.cycleN).toBe(0);
    expect(got.currentCycle).toBeNull();
    expect(got.runId).toMatch(/^ei-[0-9a-f]{8}$/);
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
