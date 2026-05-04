// Unit tests for tests/lcov-gate.ts (ADR-009 §6).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateGate,
  extractIgnorePatterns,
  formatGateReport,
  isIgnored,
  parseArgs,
  parseLcov,
  runCli,
} from "../lcov-gate.ts";

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
});

describe("formatGateReport", () => {
  test("green report names tracked + ignored counts", () => {
    const out = formatGateReport({
      ok: true,
      failures: [],
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
      trackedCount: 1,
      ignoredCount: 0,
    });
    expect(out).toContain("❌");
    expect(out).toContain("/repo/src/a.ts");
    expect(out).toContain("line: 9/10");
    expect(out).toContain("90.00%");
  });
});

describe("parseArgs", () => {
  test("defaults", () => {
    const a = parseArgs([]);
    expect(a.lcovPath).toBe("coverage/lcov.info");
    expect(a.bunfigPath).toBe("bunfig.toml");
    expect(a.threshold).toBe(1.0);
    expect(a.quiet).toBe(false);
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
    expect(exit).toBe(0);
  });
});
