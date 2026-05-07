#!/usr/bin/env bun
// ADR-009 §6: hand-rolled lcov threshold gate.
//
// Why: Bun 1.3.13's `coverageThreshold` in bunfig.toml is parsed but
// silently no-ops (empirically validated; see ADR-009 §6). CI cannot rely
// on `bun test --coverage` self-enforcing the 100% gate, so this script
// parses `coverage/lcov.info` and fails CI with per-file attribution
// when any tracked file is below 100% on line / function / branch.
//
// Single source of truth for the narrowed denominator: this script reads
// `coveragePathIgnorePatterns` directly from `bunfig.toml`. Mirroring the
// list across two configs is exactly the drift CLAUDE.md "verification
// discipline" warns about.
//
// Usage:
//   bun tests/lcov-gate.ts                    # uses coverage/lcov.info + bunfig.toml
//   bun tests/lcov-gate.ts --lcov path.info   # override input path
//   bun tests/lcov-gate.ts --bunfig path      # override bunfig path
//   bun tests/lcov-gate.ts --quiet            # suppress per-file table on green
//   bun tests/lcov-gate.ts --threshold 0.95   # override threshold (0..1, default 1.0)

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ---------- Types ----------

export interface FileCoverage {
  path: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
  branchesFound: number;
  branchesHit: number;
}

export interface CoverageReport {
  files: FileCoverage[];
  /** Files matched by `coveragePathIgnorePatterns` — excluded from the gate. */
  ignored: FileCoverage[];
}

export interface GateResult {
  ok: boolean;
  failures: ReadonlyArray<{
    path: string;
    dimension: "line" | "function" | "branch";
    hit: number;
    found: number;
    pct: number;
  }>;
  trackedCount: number;
  ignoredCount: number;
}

export interface GateOptions {
  /** 0..1 — fail if any tracked file's hit ratio is below this on any dim. */
  threshold: number;
  /** Globs to exclude from the gate. */
  ignorePatterns: ReadonlyArray<string>;
  /** Resolve relative paths against this dir (defaults to cwd). */
  cwd?: string;
}

// ---------- LCOV parser ----------

/**
 * Parse LCOV format. Spec:
 *   SF:<path>          — start of file record
 *   FNF:<n> / FNH:<n>  — functions found / hit
 *   LF:<n> / LH:<n>    — lines found / hit
 *   BRF:<n> / BRH:<n>  — branches found / hit
 *   end_of_record      — end of file
 *
 * We deliberately ignore line-by-line `DA:` / `BRDA:` / `FN:` records —
 * the LF/LH/etc summary lines are sufficient for the gate. Per-line data
 * is preserved in the artifact for human inspection.
 */
export function parseLcov(text: string): FileCoverage[] {
  const out: FileCoverage[] = [];
  let cur: Partial<FileCoverage> | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("SF:")) {
      cur = {
        path: line.slice(3),
        linesFound: 0,
        linesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
        branchesFound: 0,
        branchesHit: 0,
      };
      continue;
    }
    if (!cur) continue;
    if (line === "end_of_record") {
      out.push(cur as FileCoverage);
      cur = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const val = Number.parseInt(line.slice(colon + 1), 10);
    if (Number.isNaN(val)) continue;
    switch (key) {
      case "LF":
        cur.linesFound = val;
        break;
      case "LH":
        cur.linesHit = val;
        break;
      case "FNF":
        cur.functionsFound = val;
        break;
      case "FNH":
        cur.functionsHit = val;
        break;
      case "BRF":
        cur.branchesFound = val;
        break;
      case "BRH":
        cur.branchesHit = val;
        break;
      default:
        break; // FN:, DA:, BRDA: etc. — ignored at this level
    }
  }
  return out;
}

// ---------- bunfig.toml extractor ----------

/**
 * Extract `coveragePathIgnorePatterns` from a bunfig.toml. We don't use a
 * full TOML parser — the pattern is a simple array of strings that we can
 * pull out with a focused regex. Failure to find the array returns `[]`
 * (which makes the gate stricter, not laxer — safe default).
 */
export function extractIgnorePatterns(bunfigText: string): string[] {
  // Match: coveragePathIgnorePatterns = [ ... ]  (optional whitespace, multiline)
  const m = bunfigText.match(/coveragePathIgnorePatterns\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  const body = m[1] ?? "";
  // Strip TOML comments
  const stripped = body.replace(/#[^\n]*/g, "");
  // Pull every quoted string
  const patterns: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let mm: RegExpExecArray | null = re.exec(stripped);
  while (mm !== null) {
    patterns.push(mm[1] ?? "");
    mm = re.exec(stripped);
  }
  return patterns;
}

// ---------- Glob matching ----------

/**
 * Test whether `path` matches any of the given globs. Uses Bun's native
 * `Bun.Glob` (`tests/**` style) and tries against both the raw path and
 * the cwd-relative path so absolute lcov paths still match patterns
 * written relative to the project root.
 */
export function isIgnored(
  path: string,
  patterns: ReadonlyArray<string>,
  cwd: string,
): boolean {
  const rel = path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\//, "") : path;
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(path) || glob.match(rel)) return true;
  }
  return false;
}

// ---------- Gate ----------

export function evaluateGate(
  files: ReadonlyArray<FileCoverage>,
  opts: GateOptions,
): GateResult {
  const cwd = opts.cwd ?? process.cwd();
  const cwdNorm = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const tracked: FileCoverage[] = [];
  const ignored: FileCoverage[] = [];
  for (const f of files) {
    if (isIgnored(f.path, opts.ignorePatterns, cwdNorm)) ignored.push(f);
    else tracked.push(f);
  }
  const failures: Array<GateResult["failures"][number]> = [];
  const min = opts.threshold;
  for (const f of tracked) {
    // Lines: required dimension (zero-line files would mean empty source).
    if (f.linesFound > 0) {
      const pct = f.linesHit / f.linesFound;
      if (pct < min) {
        failures.push({
          path: f.path,
          dimension: "line",
          hit: f.linesHit,
          found: f.linesFound,
          pct,
        });
      }
    }
    if (f.functionsFound > 0) {
      const pct = f.functionsHit / f.functionsFound;
      if (pct < min) {
        failures.push({
          path: f.path,
          dimension: "function",
          hit: f.functionsHit,
          found: f.functionsFound,
          pct,
        });
      }
    }
    // Branch: only enforce when branches exist; lcov reports BRF=0 for
    // straight-line files, which is fine.
    if (f.branchesFound > 0) {
      const pct = f.branchesHit / f.branchesFound;
      if (pct < min) {
        failures.push({
          path: f.path,
          dimension: "branch",
          hit: f.branchesHit,
          found: f.branchesFound,
          pct,
        });
      }
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    trackedCount: tracked.length,
    ignoredCount: ignored.length,
  };
}

// ---------- Reporters ----------

export function formatGateReport(result: GateResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push(
      `lcov-gate: ✅ ${result.trackedCount} tracked file(s) at 100% (${result.ignoredCount} ignored)`,
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `lcov-gate: ❌ ${result.failures.length} coverage breach(es) across ${result.trackedCount} tracked file(s):`,
  );
  for (const f of result.failures) {
    const pctStr = (f.pct * 100).toFixed(2);
    lines.push(`  - ${f.path}  ${f.dimension}: ${f.hit}/${f.found}  (${pctStr}%)`);
  }
  return `${lines.join("\n")}\n`;
}

// ---------- CLI entry ----------

interface CliArgs {
  lcovPath: string;
  bunfigPath: string;
  threshold: number;
  quiet: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = {
    lcovPath: "coverage/lcov.info",
    bunfigPath: "bunfig.toml",
    threshold: 1.0,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--lcov":
        out.lcovPath = argv[++i] ?? out.lcovPath;
        break;
      case "--bunfig":
        out.bunfigPath = argv[++i] ?? out.bunfigPath;
        break;
      case "--threshold": {
        const next = argv[++i];
        if (next !== undefined) {
          const n = Number.parseFloat(next);
          if (Number.isFinite(n)) out.threshold = n;
        }
        break;
      }
      case "--quiet":
        out.quiet = true;
        break;
      default:
        // ignore unknown — keeps the script forgiving for CI experiments
        break;
    }
  }
  return out;
}

export async function runCli(argv: ReadonlyArray<string>, cwd: string): Promise<number> {
  const args = parseArgs(argv);
  const lcovAbs = resolve(cwd, args.lcovPath);
  const bunfigAbs = resolve(cwd, args.bunfigPath);
  let lcovText: string;
  try {
    lcovText = await readFile(lcovAbs, "utf8");
  } catch (e) {
    process.stderr.write(`lcov-gate: cannot read ${lcovAbs}: ${(e as Error).message}\n`);
    return 2;
  }
  let bunfigText = "";
  try {
    bunfigText = await readFile(bunfigAbs, "utf8");
  } catch {
    // expected: bunfig.toml may not exist in scratch tests; gate runs with empty patterns
    bunfigText = "";
  }
  const ignorePatterns = extractIgnorePatterns(bunfigText);
  const files = parseLcov(lcovText);
  const result = evaluateGate(files, { threshold: args.threshold, ignorePatterns, cwd });
  if (!result.ok || !args.quiet) {
    process.stdout.write(formatGateReport(result));
  }
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await runCli(Bun.argv.slice(2), process.cwd()));
}
