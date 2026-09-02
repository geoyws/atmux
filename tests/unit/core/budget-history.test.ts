// Unit tests for src/core/budget-history.ts (ADR-053 §D5).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistoryEntry,
  type BudgetHistoryEntry,
  budgetHistoryPath,
} from "../../../src/core/budget-history.ts";

let atmuxDir: string;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "atmux-bh-"));
  atmuxDir = join(tmpRoot, ".atmux");
  await mkdir(atmuxDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  expect(existsSync(tmpRoot)).toBe(false);
});

const sampleEntry = (overrides: Partial<BudgetHistoryEntry> = {}): BudgetHistoryEntry => ({
  ts: 1_700_000_000,
  account: "icloud",
  h5_util: 0.42,
  wk_util: 0.18,
  h5_reset: 1_700_003_600,
  wk_reset: 1_700_604_800,
  status: "allowed",
  source: "probe",
  tokenRefreshed: false,
  ...overrides,
});

describe("appendHistoryEntry", () => {
  test("creates the log file + parent dir on first call", async () => {
    await appendHistoryEntry(atmuxDir, sampleEntry());
    const txt = await readFile(budgetHistoryPath(atmuxDir), "utf8");
    expect(txt).toContain('"account":"icloud"');
    expect(txt.endsWith("\n")).toBe(true);
  });

  test("appends multiple entries on the same line each", async () => {
    await appendHistoryEntry(atmuxDir, sampleEntry({ ts: 1 }));
    await appendHistoryEntry(atmuxDir, sampleEntry({ ts: 2 }));
    await appendHistoryEntry(atmuxDir, sampleEntry({ ts: 3 }));
    const lines = (await readFile(budgetHistoryPath(atmuxDir), "utf8"))
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0] ?? "{}").ts).toBe(1);
    expect(JSON.parse(lines[2] ?? "{}").ts).toBe(3);
  });

  test("preserves all fields including tokenRefreshed=true", async () => {
    await appendHistoryEntry(atmuxDir, sampleEntry({ tokenRefreshed: true, status: "probe-401" }));
    const line = JSON.parse((await readFile(budgetHistoryPath(atmuxDir), "utf8")).trim());
    expect(line.tokenRefreshed).toBe(true);
    expect(line.status).toBe("probe-401");
  });

  test("write failure is swallowed (best-effort) — does not throw", async () => {
    // Pass a path that's not writable; the lock acquisition or append
    // will fail but the function must return cleanly.
    const badPath = "/proc/1/this-cannot-be-written-by-anyone";
    // Don't await rejection — just confirm no exception escapes.
    await appendHistoryEntry(badPath, sampleEntry());
    // Sanity: the legit path is unaffected.
    await appendHistoryEntry(atmuxDir, sampleEntry());
    const txt = await readFile(budgetHistoryPath(atmuxDir), "utf8");
    expect(txt).toContain('"account":"icloud"');
  });
});

describe("budgetHistoryPath", () => {
  test("resolves to <atmuxDir>/logs/budget-history.jsonl", () => {
    expect(budgetHistoryPath("/foo/.atmux")).toBe("/foo/.atmux/logs/budget-history.jsonl");
  });
});
