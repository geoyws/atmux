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

  test("unknown arg throws", () => {
    expect(() => parseImproveArgs(["--bogus"])).toThrow(UsageError);
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
});
