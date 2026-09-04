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
import { dirname, join, resolve } from "node:path";

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
  /**
   * Tracked source files that the gate EXPECTED to see in the lcov but
   * which had NO `SF:` record at all — i.e. fully-untested files (0%
   * coverage). Bun emits no record for a file that no test ever loads,
   * so these are invisible to the per-file `%%` checks above. Without
   * this completeness diff a 0%-coverage daily-firing destructive file
   * passes the gate silently (ADR-254 / finding
   * `test-lcov-gate-blind-to-zero-coverage`). Empty array when no
   * tracked universe was supplied (back-compat: lcov-only mode).
   */
  missing: ReadonlyArray<string>;
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
  /**
   * The full universe of tracked source files the gate expects to see
   * covered, expressed as cwd-relative POSIX paths (e.g.
   * `src/core/foo.ts`). When supplied, the gate diffs this set against
   * the `SF:` paths present in the lcov and FAILS for any tracked file
   * absent from the lcov — closing the "0%-coverage file is invisible"
   * blind spot (ADR-254). When omitted, the gate runs in legacy
   * lcov-only mode (iterates only files present in the parsed lcov).
   * `runCli` always supplies it via {@link enumerateTrackedSources}.
   */
  trackedUniverse?: ReadonlyArray<string>;
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
 * Normalize a path to its cwd-relative form (POSIX separators, no
 * leading slash). Absolute paths under `cwd` get the prefix stripped;
 * paths already relative pass through unchanged. This is the canonical
 * key the completeness diff (tracked-universe vs lcov-present) joins on
 * — Bun emits cwd-relative `SF:` paths (`src/foo.ts`) while
 * `Bun.Glob.scanSync({ absolute: true })` yields absolute paths, so
 * both sides MUST be funneled through the same normalizer or every file
 * would look "missing".
 */
export function toRelative(path: string, cwd: string): string {
  const cwdNorm = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(cwdNorm) ? path.slice(cwdNorm.length) : path;
}

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
  const rel = toRelative(path, cwd);
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(path) || glob.match(rel)) return true;
  }
  return false;
}

// ---------- Tracked-universe enumeration ----------

/**
 * Enumerate the real tracked-source universe by scanning `src/**` /*.ts
 * on disk, minus any file matching `coveragePathIgnorePatterns` (via the
 * SAME {@link isIgnored} logic the gate uses for present-file
 * exclusion — single source of truth, no divergent duplication).
 * Returns cwd-relative POSIX paths suitable for the completeness diff in
 * {@link evaluateGate}.
 *
 * Why this exists (ADR-254): Bun emits NO `SF:` record for a file that
 * no test ever loads. `evaluateGate`'s per-file checks iterate ONLY
 * files present in the parsed lcov, so a fully-untested file is
 * invisible and the gate prints "✅" + exits 0. Enumerating the
 * on-disk universe and diffing it against the lcov-present set is what
 * makes a 0%-coverage file fail the gate instead of hiding.
 *
 * Scoped to `src/**` per CLAUDE.md filesystem-walker discipline (never
 * rooted at `/`). `scanSync` is synchronous + fast for a few hundred
 * files; the gate is a one-shot CLI, not a hot path.
 */
export function enumerateTrackedSources(
  cwd: string,
  ignorePatterns: ReadonlyArray<string>,
): string[] {
  const glob = new Bun.Glob("src/**/*.ts");
  const out: string[] = [];
  for (const abs of glob.scanSync({ cwd, absolute: true })) {
    const rel = toRelative(abs, cwd);
    if (isIgnored(abs, ignorePatterns, cwd)) continue;
    out.push(rel);
  }
  out.sort();
  return out;
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
  // Completeness diff (ADR-254): any tracked-universe file with NO SF:
  // record in the lcov is a 0%-coverage breach Bun's per-file iteration
  // can't see. Build the set of lcov-present paths (normalized to
  // cwd-relative, the same key space the universe is expressed in) and
  // subtract it from the supplied universe. Skipped entirely when no
  // universe was supplied (legacy lcov-only mode).
  const presentRel = new Set<string>(files.map((f) => toRelative(f.path, cwdNorm)));
  const missing: string[] = [];
  if (opts.trackedUniverse !== undefined) {
    for (const rel of opts.trackedUniverse) {
      if (!presentRel.has(rel)) missing.push(rel);
    }
    missing.sort();
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
    ok: failures.length === 0 && missing.length === 0,
    failures,
    missing,
    trackedCount: tracked.length,
    ignoredCount: ignored.length,
  };
}

// ---------- Provenance (t-15bcfaf8) ----------
//
// A breach count means nothing without the command that produced it. The
// same commit, same file, read 304/304 lines under the whole-tree
// `bun test --coverage` and 296/315 under a narrower
// `bun test tests/unit tests/integration --coverage` — identical content,
// different denominator, because the instrumented line set follows which
// modules the run loaded. Two honest agents therefore reached two
// different numbers and neither was wrong.
//
// So the gate refuses to print a number without saying where it came
// from. `scripts/coverage-gate.ts` writes this sidecar next to the lcov;
// running the gate against an lcov produced any other way reports
// UNKNOWN rather than quietly implying comparability.

/** Sidecar path, relative to the lcov file's own directory. */
export const PROVENANCE_BASENAME = "lcov.provenance.json";

export interface LcovProvenance {
  /** Exact argv that produced the lcov, e.g. ["bun","test","--coverage"]. */
  readonly command: ReadonlyArray<string>;
  /** ISO-8601 UTC instant the run finished. */
  readonly finishedAt: string;
  /** Test-file count the run reported, when known — a second, cheap
   *  signal that two lcovs came from different suites. */
  readonly testFiles?: number;
}

/** Parse a provenance sidecar. Returns null for absent OR malformed —
 *  a corrupt sidecar must read as "unknown", never as a fabricated
 *  provenance, since the whole point is to not overstate what we know. */
export function parseProvenance(text: string | null): LcovProvenance | null {
  if (text === null) return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (!Array.isArray(o.command) || o.command.some((c) => typeof c !== "string")) return null;
    if (typeof o.finishedAt !== "string" || o.finishedAt === "") return null;
    const out: LcovProvenance = {
      command: o.command as ReadonlyArray<string>,
      finishedAt: o.finishedAt,
      ...(typeof o.testFiles === "number" && Number.isFinite(o.testFiles)
        ? { testFiles: o.testFiles }
        : {}),
    };
    return out;
  } catch {
    return null;
  }
}

/** The one line every quoted breach count must travel with. */
export function formatProvenanceLine(p: LcovProvenance | null): string {
  if (p === null) {
    return (
      "lcov-gate: provenance UNKNOWN — this lcov carries no record of the command that produced it.\n" +
      "           Breach counts from different suites are NOT comparable (the instrumented line set\n" +
      "           follows which modules a run loads). Produce one with `bun run coverage:gate`, and do\n" +
      "           not quote this number without naming the command yourself."
    );
  }
  const files = p.testFiles !== undefined ? `, ${p.testFiles} test file(s)` : "";
  return `lcov-gate: provenance — \`${p.command.join(" ")}\`${files}, finished ${p.finishedAt}`;
}

// ---------- Reporters ----------

export function formatGateReport(
  result: GateResult,
  provenance: LcovProvenance | null = null,
): string {
  const lines: string[] = [formatProvenanceLine(provenance)];
  if (result.ok) {
    lines.push(
      `lcov-gate: ✅ ${result.trackedCount} tracked file(s) at 100% (${result.ignoredCount} ignored)`,
    );
    return `${lines.join("\n")}\n`;
  }
  const breachCount = result.failures.length + result.missing.length;
  lines.push(
    `lcov-gate: ❌ ${breachCount} coverage breach(es) across ${result.trackedCount} tracked file(s):`,
  );
  // 0%-coverage breaches first (ADR-254) — a missing SF: record is the
  // most severe class: the file is fired in prod but no test loads it.
  if (result.missing.length > 0) {
    lines.push(
      `  ${result.missing.length} tracked file(s) with NO coverage record (0% — never loaded by any test):`,
    );
    for (const m of result.missing) {
      lines.push(`  - ${m}  0% (no SF: record in lcov)`);
    }
  }
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
  /**
   * When `true`, skip the on-disk tracked-universe completeness diff
   * (ADR-254) and run in legacy lcov-only mode. Off by default — the
   * completeness check is the whole point of the gate fix. The escape
   * hatch exists for scratch/CI experiments that point `--lcov` at a
   * synthetic file with no matching `src/` tree on disk. */
  noCompleteness: boolean;
}

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = {
    lcovPath: "coverage/lcov.info",
    bunfigPath: "bunfig.toml",
    threshold: 1.0,
    quiet: false,
    noCompleteness: false,
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
      case "--no-completeness":
        out.noCompleteness = true;
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
  // Enumerate the real on-disk tracked universe (ADR-254) unless the
  // operator opted out. This is what makes a 0%-coverage file FAIL the
  // gate instead of being invisible (Bun emits no SF: record for a file
  // no test loads).
  const trackedUniverse = args.noCompleteness
    ? undefined
    : enumerateTrackedSources(cwd, ignorePatterns);
  const result = evaluateGate(files, {
    threshold: args.threshold,
    ignorePatterns,
    cwd,
    ...(trackedUniverse !== undefined ? { trackedUniverse } : {}),
  });
  // Read the provenance sidecar written by `scripts/coverage-gate.ts`.
  // Absent or malformed both degrade to null -> the UNKNOWN banner, never
  // to a fabricated provenance.
  let provenance: LcovProvenance | null = null;
  try {
    provenance = parseProvenance(
      await readFile(join(dirname(lcovAbs), PROVENANCE_BASENAME), "utf8"),
    );
  } catch {
    provenance = null;
  }
  if (!result.ok || !args.quiet) {
    process.stdout.write(formatGateReport(result, provenance));
  }
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await runCli(Bun.argv.slice(2), process.cwd()));
}
