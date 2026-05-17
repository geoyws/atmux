// Unit tests for src/core/test-gate-bypass.ts (ADR-144 §Operator bypass
// T2 / t-49bd4fe1).
//
// Strategy: scratch $HOME via mkdtemp + injected `now` clock for
// deterministic JSONL output. Read the log file back via `readText`
// (or raw `node:fs/promises.readFile`) to verify each appended line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TEST_GATE_BYPASSES_LOG_REL,
  logTestGateBypass,
} from "../../../src/core/test-gate-bypass.ts";

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-test-gate-bypass-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function readLog(home: string): Promise<string[]> {
  const path = join(home, DEFAULT_TEST_GATE_BYPASSES_LOG_REL);
  const txt = await readFile(path, "utf8");
  return txt.split("\n").filter((l) => l.length > 0);
}

// ---------- single-line append ----------

describe("logTestGateBypass — single record", () => {
  test("writes one JSONL line with structured payload", async () => {
    await logTestGateBypass(
      {
        epicId: "e-aabb0001",
        epicBranch: "sopx-geoyws-epic-checkout",
        targetState: "merging",
        reason: "release-day emergency — failing flaky e2e known issue",
        by: "george",
      },
      { homeDir: scratch, now: () => 1779_999_000_000 },
    );
    const lines = await readLog(scratch);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}");
    expect(parsed.ts).toBe(1_779_999_000);
    expect(parsed.iso).toBe("2026-05-28T20:10:00.000Z");
    expect(parsed.epicId).toBe("e-aabb0001");
    expect(parsed.epicBranch).toBe("sopx-geoyws-epic-checkout");
    expect(parsed.targetState).toBe("merging");
    expect(parsed.reason).toContain("release-day emergency");
    expect(parsed.by).toBe("george");
  });

  test("creates parent dir if missing (ensures .atmux/state/)", async () => {
    // scratch starts with NO .atmux/state subdir — verify the
    // appendText primitive's ensureDir call creates it.
    await logTestGateBypass(
      {
        epicId: "e-fresh",
        epicBranch: "sopx-geoyws-epic-fresh",
        targetState: "merging",
        reason: "fresh-dir test",
        by: "test",
      },
      { homeDir: scratch, now: () => 1779_000_000_000 },
    );
    const lines = await readLog(scratch);
    expect(lines).toHaveLength(1);
  });

  test("writes to the default ADR-144 path `.atmux/state/test-gate-bypasses.log`", () => {
    expect(DEFAULT_TEST_GATE_BYPASSES_LOG_REL).toBe(".atmux/state/test-gate-bypasses.log");
  });
});

// ---------- multi-line append (audit trail) ----------

describe("logTestGateBypass — append-only audit trail", () => {
  test("two records land as two separate JSONL lines, oldest first", async () => {
    await logTestGateBypass(
      {
        epicId: "e-1",
        epicBranch: "br-1",
        targetState: "merging",
        reason: "first",
        by: "alice",
      },
      { homeDir: scratch, now: () => 1779_000_000_000 },
    );
    await logTestGateBypass(
      {
        epicId: "e-2",
        epicBranch: "br-2",
        targetState: "merging",
        reason: "second",
        by: "bob",
      },
      { homeDir: scratch, now: () => 1779_000_010_000 },
    );
    const lines = await readLog(scratch);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "{}");
    const second = JSON.parse(lines[1] ?? "{}");
    expect(first.epicId).toBe("e-1");
    expect(first.by).toBe("alice");
    expect(second.epicId).toBe("e-2");
    expect(second.by).toBe("bob");
    expect(second.ts).toBeGreaterThan(first.ts);
  });

  test("each line is valid JSON parseable independently", async () => {
    for (let i = 0; i < 5; i++) {
      await logTestGateBypass(
        {
          epicId: `e-${i}`,
          epicBranch: `br-${i}`,
          targetState: "merging",
          reason: `bypass #${i}`,
          by: "operator",
        },
        { homeDir: scratch, now: () => 1779_000_000_000 + i * 1000 },
      );
    }
    const lines = await readLog(scratch);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("ts column is epoch seconds (integer), iso is ISO 8601 UTC", async () => {
    await logTestGateBypass(
      {
        epicId: "e-x",
        epicBranch: "br-x",
        targetState: "merging",
        reason: "type check",
        by: "test",
      },
      { homeDir: scratch, now: () => 1779_000_000_000 + 750 /* sub-second */ },
    );
    const parsed = JSON.parse((await readLog(scratch))[0] ?? "{}");
    expect(Number.isInteger(parsed.ts)).toBe(true);
    expect(parsed.iso.endsWith("Z")).toBe(true);
  });
});

// ---------- payload preservation ----------

describe("logTestGateBypass — payload fidelity", () => {
  test("reason with newlines / quotes survives JSON round-trip", async () => {
    const tricky = 'release-day "emergency"\nflaky e2e, ADR-144 §Operator bypass';
    await logTestGateBypass(
      {
        epicId: "e-q",
        epicBranch: "br-q",
        targetState: "merging",
        reason: tricky,
        by: "george",
      },
      { homeDir: scratch, now: () => 1779_000_000_000 },
    );
    const parsed = JSON.parse((await readLog(scratch))[0] ?? "{}");
    expect(parsed.reason).toBe(tricky);
  });

  test("by attribution carries non-ASCII safely", async () => {
    await logTestGateBypass(
      {
        epicId: "e-u",
        epicBranch: "br-u",
        targetState: "merging",
        reason: "unicode by-field",
        by: "geöyws-八",
      },
      { homeDir: scratch, now: () => 1779_000_000_000 },
    );
    const parsed = JSON.parse((await readLog(scratch))[0] ?? "{}");
    expect(parsed.by).toBe("geöyws-八");
  });
});
