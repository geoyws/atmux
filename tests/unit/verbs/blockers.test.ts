// Unit tests for src/verbs/blockers.ts — ADR-152 `atmux blockers list`
// verb layer (argv parse, filters, render) + the ADR-272 P3 / ADR-152
// §Amendment 2026-08-14 `--team-dir` flag.
//
// The core fan-out (`queryAllBlockers`) is covered in
// tests/unit/core/blockers.test.ts; this file owns the verb surface:
// parsing (every flag + every refusal), pure filter/format/render
// helpers, and the end-to-end `--team-dir` threading against a staged
// fixture team (empty state → "(no blockers)").

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockerRow } from "../../../src/core/blockers.ts";
import { UsageError } from "../../../src/errors.ts";
import {
  applyFilters,
  blockers,
  formatAge,
  parseBlockersArgs,
  parseDurationToSec,
  renderTable,
} from "../../../src/verbs/blockers.ts";
import { captureStdio } from "../../helpers/capture.ts";

function row(overrides: Partial<BlockerRow> = {}): BlockerRow {
  return {
    id: "t-1",
    source: "sqlite-tasks-blocked",
    blocker_class: "member-stuck",
    age_sec: 120,
    summary: "a blocked task",
    ...overrides,
  } as BlockerRow;
}

describe("parseDurationToSec", () => {
  test.each([
    ["bare seconds", "90", 90],
    ["s suffix", "30s", 30],
    ["m suffix", "30m", 1800],
    ["h suffix", "2h", 7200],
    ["d suffix", "7d", 604800],
    ["zero", "0", 0],
  ])("%s: %j → %d", (_name, raw, expected) => {
    expect(parseDurationToSec(raw)).toBe(expected);
  });

  test.each([
    ["", null],
    ["abc", null],
    ["-5", null],
    ["5w", null],
    ["m30", null],
  ])("%j → null", (raw, expected) => {
    expect(parseDurationToSec(raw)).toBe(expected);
  });
});

describe("parseBlockersArgs", () => {
  test("missing sub-verb → UsageError", () => {
    expect(() => parseBlockersArgs([])).toThrow(UsageError);
  });

  test("unknown sub-verb → UsageError", () => {
    expect(() => parseBlockersArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("bare list", () => {
    expect(parseBlockersArgs(["list"])).toEqual({ subverb: "list" });
  });

  test("--json", () => {
    expect(parseBlockersArgs(["list", "--json"])).toEqual({ subverb: "list", json: true });
  });

  test("--class with a valid class", () => {
    expect(parseBlockersArgs(["list", "--class", "member-stuck"])).toEqual({
      subverb: "list",
      class: "member-stuck",
    });
  });

  test.each([
    [["list", "--class"]],
    [["list", "--class", "not-a-class"]],
    [["list", "--source"]],
    [["list", "--source", "not-a-source"]],
    [["list", "--max-age"]],
    [["list", "--max-age", "banana"]],
    [["list", "--team-dir"]],
    [["list", "--wat"]],
  ])("refusal: %j → UsageError", (argv) => {
    expect(() => parseBlockersArgs(argv as string[])).toThrow(UsageError);
  });

  test("--source with a valid source", () => {
    expect(parseBlockersArgs(["list", "--source", "sqlite-tasks-blocked"])).toEqual({
      subverb: "list",
      source: "sqlite-tasks-blocked",
    });
  });

  test("--max-age suffix form", () => {
    expect(parseBlockersArgs(["list", "--max-age", "30m"])).toEqual({
      subverb: "list",
      maxAgeSec: 1800,
    });
  });

  test("--team-dir captured (ADR-152 §Amendment 2026-08-14)", () => {
    expect(parseBlockersArgs(["list", "--team-dir", "/w/x"])).toEqual({
      subverb: "list",
      teamDir: "/w/x",
    });
  });

  test("all flags combine", () => {
    expect(
      parseBlockersArgs([
        "list",
        "--json",
        "--class",
        "member-stuck",
        "--source",
        "sqlite-tasks-blocked",
        "--max-age",
        "2h",
        "--team-dir",
        "/w/x",
      ]),
    ).toEqual({
      subverb: "list",
      json: true,
      class: "member-stuck",
      source: "sqlite-tasks-blocked",
      maxAgeSec: 7200,
      teamDir: "/w/x",
    });
  });
});

describe("applyFilters", () => {
  const rows = [
    row({ id: "a", blocker_class: "member-stuck", source: "sqlite-tasks-blocked", age_sec: 100 }),
    row({
      id: "b",
      blocker_class: "review-pending",
      source: "sqlite-merger-state",
      age_sec: 90_000,
    }),
  ];

  test("no filters → all rows", () => {
    expect(applyFilters(rows, { subverb: "list" })).toEqual(rows);
  });

  test("class filter", () => {
    expect(applyFilters(rows, { subverb: "list", class: "member-stuck" }).map((r) => r.id)).toEqual(
      ["a"],
    );
  });

  test("source filter", () => {
    expect(
      applyFilters(rows, { subverb: "list", source: "sqlite-merger-state" }).map((r) => r.id),
    ).toEqual(["b"]);
  });

  test("max-age drops strictly older rows", () => {
    expect(applyFilters(rows, { subverb: "list", maxAgeSec: 3600 }).map((r) => r.id)).toEqual([
      "a",
    ]);
  });
});

describe("formatAge", () => {
  test.each([
    [0, "now"],
    [-5, "now"],
    [59, "0min"],
    [120, "2min"],
    [3599, "59min"],
    [3600, "1h"],
    [3660, "1h1m"],
    [7200, "2h"],
  ])("%d → %s", (sec, expected) => {
    expect(formatAge(sec)).toBe(expected);
  });
});

describe("renderTable", () => {
  test("empty → (no blockers)", () => {
    expect(renderTable([])).toBe("(no blockers)\n");
  });

  test("rows render id/class/age/summary columns", () => {
    const out = renderTable([row({ id: "t-x", age_sec: 120, summary: "stuck" })]);
    expect(out).toContain("ID");
    expect(out).toContain("t-x");
    expect(out).toContain("member-stuck");
    expect(out).toContain("2min");
    expect(out).toContain("stuck");
  });
});

describe("blockers() — --team-dir threading (end-to-end, empty fixture team)", () => {
  async function stageTeam(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "atmux-blockers-"));
    const atmuxDir = join(dir, ".atmux");
    await mkdir(atmuxDir, { recursive: true });
    await writeFile(join(atmuxDir, "team.json"), JSON.stringify({ name: "fix", members: [] }));
    return dir;
  }

  test("table output via the flag", async () => {
    const dir = await stageTeam();
    const { result, stdout } = await captureStdio(() => blockers(["list", "--team-dir", dir]));
    expect(result).toBe(0);
    expect(stdout).toBe("(no blockers)\n");
  });

  test("--json output via the flag", async () => {
    const dir = await stageTeam();
    const { result, stdout } = await captureStdio(() =>
      blockers(["list", "--json", "--team-dir", dir]),
    );
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("flag wins over the caller-provided dirOpts param", async () => {
    const dir = await stageTeam();
    const { result, stdout } = await captureStdio(() =>
      blockers(["list", "--team-dir", dir], { teamDir: "/nonexistent/nowhere" }),
    );
    expect(result).toBe(0);
    expect(stdout).toBe("(no blockers)\n");
  });
});
