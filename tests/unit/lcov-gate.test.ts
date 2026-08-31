// Unit tests for tests/lcov-gate.ts (ADR-009 §6).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enumerateTrackedSources,
  evaluateGate,
  extractIgnorePatterns,
  formatGateReport,
  isIgnored,
  parseArgs,
  parseLcov,
  runCli,
  toRelative,
} from "../lcov-gate.ts";

const repoRoot = join(import.meta.dir, "..", "..");
const exactTypeOnlyPaths = [
  "src/abstractions/agent-backend.ts",
  "src/abstractions/issue-tracker.ts",
  "src/abstractions/voice-provider.ts",
  "src/core/cursor-recipes/types.ts",
  "src/core/sync-claude-team-json/types.ts",
] as const;

describe("parseLcov", () => {
  test("parses one file record", () => {
    const text = [
      "TN:",
      "SF:/abs/src/foo.ts",
      "FNF:3",
      "FNH:3",
      "LF:10",
      "LH:10",
      "BRF:4",
      "BRH:4",
      "end_of_record",
      "",
    ].join("\n");
    const files = parseLcov(text);
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      path: "/abs/src/foo.ts",
      linesFound: 10,
      linesHit: 10,
      functionsFound: 3,
      functionsHit: 3,
      branchesFound: 4,
      branchesHit: 4,
    });
  });

  test("parses multiple records", () => {
    const text = [
      "SF:/a.ts",
      "LF:5",
      "LH:5",
      "end_of_record",
      "SF:/b.ts",
      "LF:8",
      "LH:6",
      "end_of_record",
    ].join("\n");
    const files = parseLcov(text);
    expect(files).toHaveLength(2);
    expect(files[0]?.path).toBe("/a.ts");
    expect(files[1]?.linesHit).toBe(6);
  });

  test("skips junk lines and unknown keys", () => {
    const text = [
      "SF:/x.ts",
      "DA:1,1",
      "DA:2,0",
      "FN:1,foo",
      "BRDA:1,0,0,1",
      "WHATEVER:not-a-real-key",
      "LF:2",
      "LH:1",
      "end_of_record",
    ].join("\n");
    const files = parseLcov(text);
    expect(files[0]?.linesFound).toBe(2);
  });

  test("ignores values that aren't integers", () => {
    const text = ["SF:/x.ts", "LF:not-a-number", "LH:5", "end_of_record"].join("\n");
    const files = parseLcov(text);
    expect(files[0]?.linesFound).toBe(0);
    expect(files[0]?.linesHit).toBe(5);
  });

  test("ignores lines outside any SF block", () => {
    const text = ["LF:99", "SF:/x.ts", "LF:1", "LH:1", "end_of_record"].join("\n");
    const files = parseLcov(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.linesFound).toBe(1);
  });

  test("handles empty input", () => {
    expect(parseLcov("")).toEqual([]);
  });

  test("ignores lines without colon mid-record", () => {
    const text = ["SF:/x.ts", "noop-line", "LF:1", "LH:1", "end_of_record"].join("\n");
    const files = parseLcov(text);
    expect(files[0]?.linesFound).toBe(1);
  });
});

describe("extractIgnorePatterns", () => {
  test("extracts a multi-line array", () => {
    const toml = `
[test]
coverage = true
coveragePathIgnorePatterns = [
  "src/types/generated/**",
  "**/index.ts",
  "tests/**",
  "**/*.fixtures.ts",
]
`;
    expect(extractIgnorePatterns(toml)).toEqual([
      "src/types/generated/**",
      "**/index.ts",
      "tests/**",
      "**/*.fixtures.ts",
    ]);
  });

  test("strips comments inside the array", () => {
    const toml = `coveragePathIgnorePatterns = [
  "src/foo/**",   # generated
  "tests/**"      # excluded per ADR-009 §2
]`;
    expect(extractIgnorePatterns(toml)).toEqual(["src/foo/**", "tests/**"]);
  });

  test("returns [] when key is absent", () => {
    expect(extractIgnorePatterns("[test]\ncoverage = true\n")).toEqual([]);
  });

  test("returns [] for an empty array literal", () => {
    expect(extractIgnorePatterns("coveragePathIgnorePatterns = []")).toEqual([]);
  });

  test("handles inline-array form", () => {
    expect(extractIgnorePatterns(`coveragePathIgnorePatterns = ["a/**", "b/**"]`)).toEqual([
      "a/**",
      "b/**",
    ]);
  });
});

describe("coveragePathIgnorePatterns policy", () => {
  test("lists only exact compile-time-only seams and keeps runtime-bearing types.ts tracked", async () => {
    const toml = await readFile(join(repoRoot, "bunfig.toml"), "utf8");
    const patterns = extractIgnorePatterns(toml);
    expect(patterns).toEqual([
      "src/types/generated/**",
      "**/index.ts",
      "tests/**",
      "**/*.fixtures.ts",
      ...exactTypeOnlyPaths,
    ]);
    expect(patterns).not.toContain("**/types.ts");
  });
});

describe("isIgnored", () => {
  test("matches against cwd-relative path", () => {
    expect(isIgnored("/repo/tests/foo.ts", ["tests/**"], "/repo/")).toBe(true);
  });

  test("matches against absolute path directly", () => {
    expect(isIgnored("/abs/x.fixtures.ts", ["**/*.fixtures.ts"], "/repo/")).toBe(true);
  });

  test("returns false when no pattern matches", () => {
    expect(isIgnored("/repo/src/foo.ts", ["tests/**"], "/repo/")).toBe(false);
  });

  test("empty pattern list returns false", () => {
    expect(isIgnored("/anything", [], "/repo/")).toBe(false);
  });

  test("path equal to cwd-prefix slash boundary", () => {
    expect(isIgnored("/repo/tests/x.ts", ["tests/**"], "/repo")).toBe(true);
  });
});

describe("evaluateGate", () => {
  const trackedFile = (
    path: string,
    linesHit = 10,
    linesFound = 10,
  ): import("../lcov-gate.ts").FileCoverage => ({
    path,
    linesFound,
    linesHit,
    functionsFound: 2,
    functionsHit: 2,
    branchesFound: 0,
    branchesHit: 0,
  });

  test("green when all tracked files at 100% and patterns absent", () => {
    const result = evaluateGate([trackedFile("/repo/src/a.ts")], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.ok).toBe(true);
    expect(result.trackedCount).toBe(1);
    expect(result.ignoredCount).toBe(0);
  });

  test("fails when line coverage below threshold", () => {
    const result = evaluateGate([trackedFile("/repo/src/a.ts", 9, 10)], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.dimension).toBe("line");
    expect(result.failures[0]?.path).toBe("/repo/src/a.ts");
  });

  test("ignored files don't count toward gate", () => {
    const files = [trackedFile("/repo/tests/foo.test.ts", 0, 5)];
    const result = evaluateGate(files, {
      threshold: 1.0,
      ignorePatterns: ["tests/**"],
      cwd: "/repo",
    });
    expect(result.ok).toBe(true);
    expect(result.trackedCount).toBe(0);
    expect(result.ignoredCount).toBe(1);
  });

  test("function dimension breach reported", () => {
    const f: import("../lcov-gate.ts").FileCoverage = {
      path: "/repo/src/a.ts",
      linesFound: 10,
      linesHit: 10,
      functionsFound: 4,
      functionsHit: 3,
      branchesFound: 0,
      branchesHit: 0,
    };
    const result = evaluateGate([f], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.find((x) => x.dimension === "function")).toBeDefined();
  });

  test("branch dimension breach reported when branches exist", () => {
    const f: import("../lcov-gate.ts").FileCoverage = {
      path: "/repo/src/a.ts",
      linesFound: 10,
      linesHit: 10,
      functionsFound: 2,
      functionsHit: 2,
      branchesFound: 4,
      branchesHit: 3,
    };
    const result = evaluateGate([f], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((x) => x.dimension === "branch")).toBe(true);
  });

  test("zero-line files are not failed (no denominator)", () => {
    const f: import("../lcov-gate.ts").FileCoverage = {
      path: "/repo/src/empty.ts",
      linesFound: 0,
      linesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
      branchesFound: 0,
      branchesHit: 0,
    };
    const result = evaluateGate([f], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.ok).toBe(true);
  });

  test("threshold below 1.0 lets partial coverage pass", () => {
    const result = evaluateGate([trackedFile("/repo/src/a.ts", 9, 10)], {
      threshold: 0.9,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.ok).toBe(true);
  });

  test("uses process.cwd() when cwd is not provided", () => {
    const result = evaluateGate([trackedFile("/repo/src/a.ts")], {
      threshold: 1.0,
      ignorePatterns: [],
    });
    expect(result.trackedCount).toBe(1);
  });

  test("no trackedUniverse supplied → missing is empty (legacy lcov-only mode)", () => {
    const result = evaluateGate([trackedFile("/repo/src/a.ts")], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
    });
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("evaluateGate — completeness diff (ADR-254 / the gate blind spot)", () => {
  const fullFile = (path: string): import("../lcov-gate.ts").FileCoverage => ({
    path,
    linesFound: 10,
    linesHit: 10,
    functionsFound: 2,
    functionsHit: 2,
    branchesFound: 0,
    branchesHit: 0,
  });

  // THE blind-spot regression: a tracked file present in the on-disk
  // universe but with NO SF: record in the lcov (0% coverage, Bun emits
  // nothing for a file no test loads) MUST fail the gate. Pre-ADR-254
  // the gate iterated only lcov-present files, so this exact shape
  // printed "✅" + exited 0 (finding test-lcov-gate-blind-to-zero-coverage).
  test("FAILS when a tracked-universe file is absent from the lcov (0% coverage)", () => {
    const lcovPresent = [fullFile("src/core/covered.ts")];
    const universe = ["src/core/covered.ts", "src/core/events-prune.ts"];
    const result = evaluateGate(lcovPresent, {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
      trackedUniverse: universe,
    });
    // If the feature were broken, this would be `true` (the old blind
    // spot) — so the assertion bottom-up answer is NO.
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["src/core/events-prune.ts"]);
    // The covered file is NOT flagged missing.
    expect(result.missing).not.toContain("src/core/covered.ts");
    // The missing filename surfaces in the formatted report.
    const report = formatGateReport(result);
    expect(report).toContain("src/core/events-prune.ts");
    expect(report).toContain("0%");
  });

  test("multiple missing files all reported, sorted", () => {
    const result = evaluateGate([fullFile("src/a.ts")], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
      trackedUniverse: ["src/a.ts", "src/z.ts", "src/m.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["src/m.ts", "src/z.ts"]);
  });

  test("green when the lcov covers the entire tracked universe", () => {
    const result = evaluateGate([fullFile("src/a.ts"), fullFile("src/b.ts")], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
      trackedUniverse: ["src/a.ts", "src/b.ts"],
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test("absolute lcov SF paths normalize to match a cwd-relative universe", () => {
    // Bun emits cwd-relative SF paths, but the diff must not break if a
    // caller feeds absolute SF paths — toRelative funnels both sides to
    // the same key space.
    const result = evaluateGate([fullFile("/repo/src/a.ts")], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
      trackedUniverse: ["src/a.ts"],
    });
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("a partial-coverage breach AND a missing file both fail together", () => {
    const partial: import("../lcov-gate.ts").FileCoverage = {
      path: "src/a.ts",
      linesFound: 10,
      linesHit: 5,
      functionsFound: 2,
      functionsHit: 2,
      branchesFound: 0,
      branchesHit: 0,
    };
    const result = evaluateGate([partial], {
      threshold: 1.0,
      ignorePatterns: [],
      cwd: "/repo",
      trackedUniverse: ["src/a.ts", "src/b.ts"],
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.path === "src/a.ts")).toBe(true);
    expect(result.missing).toEqual(["src/b.ts"]);
  });
});

describe("toRelative", () => {
  test("strips a cwd prefix (with trailing slash) from an absolute path", () => {
    expect(toRelative("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
  });

  test("strips a cwd prefix when cwd already has a trailing slash", () => {
    expect(toRelative("/repo/src/a.ts", "/repo/")).toBe("src/a.ts");
  });

  test("passes an already-relative path through unchanged", () => {
    expect(toRelative("src/a.ts", "/repo")).toBe("src/a.ts");
  });

  test("leaves a path outside cwd unchanged", () => {
    expect(toRelative("/other/src/a.ts", "/repo")).toBe("/other/src/a.ts");
  });
});

describe("enumerateTrackedSources (scans the real worktree src/ tree)", () => {
  // This file (tests/lcov-gate.ts is excluded via tests/**, but its
  // SUBJECT modules live under src/). We scan the real repo so the
  // assertion is grounded in actual on-disk truth, not a fixture.
  test("includes known tracked src files and excludes ignored ones", async () => {
    const ignore = extractIgnorePatterns(await readFile(join(repoRoot, "bunfig.toml"), "utf8"));
    const tracked = enumerateTrackedSources(repoRoot, ignore);
    // Real destructive modules ADR-254 cares about must be in-universe.
    expect(tracked).toContain("src/core/events-prune.ts");
    expect(tracked).toContain("src/core/event-subscriptions.ts");
    // The exact-path compile-time-only seams are excluded from the gate.
    for (const p of exactTypeOnlyPaths) {
      expect(tracked).not.toContain(p);
    }
    // Runtime-bearing types.ts files stay tracked.
    expect(tracked).toContain("src/verbs/doctor/types.ts");
    expect(tracked).toContain("src/core/spawn-override.ts");
    // Paths are cwd-relative, POSIX, no leading slash.
    for (const p of tracked) {
      expect(p.startsWith("/")).toBe(false);
      expect(p.startsWith("src/")).toBe(true);
      expect(p.endsWith(".ts")).toBe(true);
    }
    // Sorted ascending.
    const sorted = [...tracked].sort();
    expect(tracked).toEqual(sorted);
  });

  test("honors ignore patterns — barrels (**/index.ts) are excluded", () => {
    const withIgnore = enumerateTrackedSources(repoRoot, ["**/index.ts"]);
    expect(withIgnore.some((p) => p.endsWith("/index.ts"))).toBe(false);
  });

  test("empty ignore list still scans (no file excluded by patterns)", () => {
    const all = enumerateTrackedSources(repoRoot, []);
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain("src/core/events-prune.ts");
    expect(all).toContain("src/verbs/doctor/types.ts");
  });
});

describe("formatGateReport", () => {
  test("green report names tracked + ignored counts", () => {
    const out = formatGateReport({
      ok: true,
      failures: [],
      missing: [],
      trackedCount: 4,
      ignoredCount: 2,
    });
    expect(out).toContain("✅");
    expect(out).toContain("4 tracked");
    expect(out).toContain("2 ignored");
  });

  test("red report lists every breach with dimension + ratio", () => {
    const out = formatGateReport({
      ok: false,
      failures: [
        {
          path: "/repo/src/a.ts",
          dimension: "line",
          hit: 9,
          found: 10,
          pct: 0.9,
        },
      ],
      missing: [],
      trackedCount: 1,
      ignoredCount: 0,
    });
    expect(out).toContain("❌");
    expect(out).toContain("/repo/src/a.ts");
    expect(out).toContain("line: 9/10");
    expect(out).toContain("90.00%");
  });

  test("red report lists 0%-coverage (missing) files with the filename + count", () => {
    const out = formatGateReport({
      ok: false,
      failures: [],
      missing: ["src/core/events-prune.ts", "src/core/event-subscriptions.ts"],
      trackedCount: 5,
      ignoredCount: 0,
    });
    expect(out).toContain("❌");
    // The breach count combines failures + missing.
    expect(out).toContain("2 coverage breach(es)");
    // Both untested filenames must appear by name (the operator needs
    // to know WHICH file is uncovered — ADR-254).
    expect(out).toContain("src/core/events-prune.ts");
    expect(out).toContain("src/core/event-subscriptions.ts");
    // Explicitly labels them 0% / no-record so the breach class is
    // unambiguous vs a partial-coverage failure.
    expect(out).toContain("0%");
    expect(out).toContain("no SF: record");
  });

  test("red report counts BOTH partial-coverage and missing breaches", () => {
    const out = formatGateReport({
      ok: false,
      failures: [{ path: "src/core/a.ts", dimension: "line", hit: 9, found: 10, pct: 0.9 }],
      missing: ["src/core/b.ts"],
      trackedCount: 2,
      ignoredCount: 0,
    });
    // 1 partial + 1 missing = 2 total breaches.
    expect(out).toContain("2 coverage breach(es)");
    expect(out).toContain("src/core/a.ts");
    expect(out).toContain("src/core/b.ts");
  });
});

describe("parseArgs", () => {
  test("defaults", () => {
    const a = parseArgs([]);
    expect(a.lcovPath).toBe("coverage/lcov.info");
    expect(a.bunfigPath).toBe("bunfig.toml");
    expect(a.threshold).toBe(1.0);
    expect(a.quiet).toBe(false);
    // Completeness diff is ON by default — opting out is explicit only.
    expect(a.noCompleteness).toBe(false);
  });

  test("--no-completeness opts out of the tracked-universe diff", () => {
    const a = parseArgs(["--no-completeness"]);
    expect(a.noCompleteness).toBe(true);
  });

  test("override flags", () => {
    const a = parseArgs([
      "--lcov",
      "x/y.info",
      "--bunfig",
      "z.toml",
      "--threshold",
      "0.95",
      "--quiet",
    ]);
    expect(a.lcovPath).toBe("x/y.info");
    expect(a.bunfigPath).toBe("z.toml");
    expect(a.threshold).toBe(0.95);
    expect(a.quiet).toBe(true);
  });

  test("ignores threshold without numeric arg", () => {
    const a = parseArgs(["--threshold", "not-a-number"]);
    expect(a.threshold).toBe(1.0);
  });

  test("ignores threshold flag without value", () => {
    const a = parseArgs(["--threshold"]);
    expect(a.threshold).toBe(1.0);
  });

  test("ignores --lcov flag without value", () => {
    const a = parseArgs(["--lcov"]);
    expect(a.lcovPath).toBe("coverage/lcov.info");
  });

  test("ignores --bunfig flag without value", () => {
    const a = parseArgs(["--bunfig"]);
    expect(a.bunfigPath).toBe("bunfig.toml");
  });

  test("ignores unknown flags", () => {
    const a = parseArgs(["--what-is-this", "huh"]);
    expect(a.lcovPath).toBe("coverage/lcov.info");
  });
});

describe("runCli (integration)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lcov-gate-"));
    await mkdir(join(dir, "coverage"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns 0 when all tracked files green", async () => {
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:/repo/src/a.ts\nLF:1\nLH:1\nend_of_record\n",
      "utf8",
    );
    await writeFile(join(dir, "bunfig.toml"), "", "utf8");
    const exit = await runCli(["--quiet"], dir);
    expect(exit).toBe(0);
  });

  test("returns 1 when a file is below threshold", async () => {
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:/repo/src/a.ts\nLF:10\nLH:5\nend_of_record\n",
      "utf8",
    );
    await writeFile(join(dir, "bunfig.toml"), "", "utf8");
    const exit = await runCli([], dir);
    expect(exit).toBe(1);
  });

  test("returns 2 when lcov file is missing", async () => {
    const exit = await runCli(["--lcov", "nope.info"], dir);
    expect(exit).toBe(2);
  });

  test("respects ignorePatterns from bunfig.toml", async () => {
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:tests/x.test.ts\nLF:0\nLH:0\nend_of_record\n",
      "utf8",
    );
    await writeFile(
      join(dir, "bunfig.toml"),
      `coveragePathIgnorePatterns = ["tests/**"]\n`,
      "utf8",
    );
    const exit = await runCli(["--quiet"], dir);
    expect(exit).toBe(0);
  });

  test("works when bunfig.toml is missing", async () => {
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:/repo/src/a.ts\nLF:1\nLH:1\nend_of_record\n",
      "utf8",
    );
    const exit = await runCli(["--quiet", "--bunfig", "no-such-bunfig.toml"], dir);
    expect(exit).toBe(0);
  });

  test("--lcov / --bunfig overrides accept relative paths", async () => {
    await writeFile(
      join(dir, "alt.lcov"),
      "SF:/repo/src/a.ts\nLF:1\nLH:1\nend_of_record\n",
      "utf8",
    );
    const exit = await runCli(["--lcov", "alt.lcov", "--quiet"], dir);
    // alt.lcov references /repo/src/a.ts, but the completeness diff
    // scans `dir/src/**` which is empty → no missing files (universe is
    // empty) → green. Confirms the completeness pass doesn't false-fail
    // when the on-disk universe is empty.
    expect(exit).toBe(0);
  });

  // ADR-254 end-to-end: a real on-disk src/ tree where one file has NO
  // SF: record in the lcov MUST fail the gate (exit 1) and name the
  // uncovered file in the report. This is the runCli-level guard against
  // the blind spot — the per-function evaluateGate tests above prove the
  // diff; this proves runCli wires enumerateTrackedSources into it.
  test("FAILS (exit 1) when a real src/ file is absent from the lcov, naming it", async () => {
    await mkdir(join(dir, "src", "core"), { recursive: true });
    await writeFile(join(dir, "src", "core", "covered.ts"), "export const a = 1;\n", "utf8");
    await writeFile(join(dir, "src", "core", "untested.ts"), "export const b = 2;\n", "utf8");
    // lcov covers ONLY covered.ts — untested.ts is the 0%-coverage file.
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:src/core/covered.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n",
      "utf8",
    );
    await writeFile(join(dir, "bunfig.toml"), "", "utf8");

    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // Narrow capture override (restored in finally). The cast funnels
    // the single-arg test stub through the real multi-overload signature.
    process.stdout.write = ((s: string | Uint8Array): boolean => {
      chunks.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      return true;
    }) as typeof process.stdout.write;
    let exit: number;
    try {
      exit = await runCli([], dir);
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join("");
    expect(exit).toBe(1);
    expect(out).toContain("src/core/untested.ts");
    expect(out).toContain("0%");
    // The covered file is NOT named as a breach.
    expect(out).not.toContain("src/core/covered.ts  0%");
  });

  test("--no-completeness restores legacy lcov-only mode (no false-fail on untested src)", async () => {
    await mkdir(join(dir, "src", "core"), { recursive: true });
    await writeFile(join(dir, "src", "core", "untested.ts"), "export const b = 2;\n", "utf8");
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:src/core/covered.ts\nLF:1\nLH:1\nend_of_record\n",
      "utf8",
    );
    await writeFile(join(dir, "bunfig.toml"), "", "utf8");
    // With completeness ON this would be exit 1; --no-completeness opts out.
    const exit = await runCli(["--no-completeness", "--quiet"], dir);
    expect(exit).toBe(0);
  });

  test("green when the real src/ tree is fully covered by the lcov", async () => {
    await mkdir(join(dir, "src", "core"), { recursive: true });
    await writeFile(join(dir, "src", "core", "only.ts"), "export const a = 1;\n", "utf8");
    await writeFile(
      join(dir, "coverage/lcov.info"),
      "SF:src/core/only.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n",
      "utf8",
    );
    await writeFile(join(dir, "bunfig.toml"), "", "utf8");
    const exit = await runCli(["--quiet"], dir);
    expect(exit).toBe(0);
  });
});
