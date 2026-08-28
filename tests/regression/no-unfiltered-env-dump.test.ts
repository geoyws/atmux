// ADR-282 — a TRIPWIRE for known whole-environment-capture shapes.
//
// Read the claim before the code, because the claim was wrong once.
//
// WHAT THIS IS. A source scan that fails the suite when a file under one
// of the scanned roots writes one of the enumerated whole-environment
// capture shapes. It catches the shape that caused the 2026-08-28
// disclosure and the shapes a reviewer produced while trying to get past
// it.
//
// WHAT THIS IS NOT. It is **not** a proof that no test can capture the
// environment, and ADR-282's original wording — "so the class cannot come
// back", "taking any other route fails the suite" — was false and has
// been withdrawn. Pattern-matching arbitrary code for "unfiltered env
// capture" is undecidable in the direction that matters. Measured
// 2026-08-28 over an enumeration of 21 capture shapes, the first version
// of this matcher caught 9 — and the widened one catching all 21 proves
// nothing beyond that enumeration, since it was widened against it.
// The residual gaps are enumerated in ADR-283 §Residual gaps
// rather than left for the next reviewer to rediscover, and the two
// obvious ones are restated here:
//
//   - The scan is LINE-ORIENTED. An argv array split across lines
//     (`cmd: [\n  "env",\n]`) is not matched.
//   - It scans SOURCE. A capture assembled at runtime — from a string
//     built by concatenation, from a variable, from `eval` — is invisible
//     to it by construction.
//
// The defence that does not depend on recognising code is ADR-283: the
// test runner's environment is built from an allowlist, so the variables
// worth stealing are not in the process for any shape to capture. This
// file remains worth having because it catches the mistake early, at the
// place it is written, with a message naming the safe route — but it is
// the second line, not the first.
//
// Self-application: this file scans itself like every other, and there is
// NO path exclusion list. The forbidden fragments below are assembled
// from pieces at runtime precisely so that no carve-out is needed — a
// carve-out is the first thing a future author would reach for to get
// past the guard.
//
// The safe form lives in tests/helpers/env-dump.ts (`dumpEnvCommand`).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpEnvCommand, ENV_DUMP_ALLOWLIST } from "../helpers/env-dump.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Roots that get scanned.
 *
 * `src/` is included because a test helper (or a diagnostic verb) could
 * just as easily dump an environment. `scripts/`, `bin/`, `templates/`
 * and `plugins/` were added 2026-08-28: every one of them carries
 * executable shell, and `scripts/` and `bin/` are outside biome's
 * `files.includes`, so nothing else in the repository looks at them at
 * all.
 */
const SCAN_ROOTS = ["src", "tests", "scripts", "bin", "templates", "plugins"] as const;

const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".bash", ".bats"]);

/**
 * Minimum file count per root, so the assertion cannot pass because the
 * walk found nothing.
 *
 * `scan()` returns `[]` both when nothing violates and when nothing was
 * scanned, which made the headline assertion vacuous under any discovery
 * regression: a reviewer set `SCAN_EXTS` to the empty set with a real
 * violation planted on disk and the suite stayed green.
 *
 * These catch a COLLAPSE, not a file count — deleting a file is normal,
 * a root going to zero is a broken walk. Set at roughly half the counts
 * measured 2026-08-28 (src 309, tests 477, scripts 22, bin 3,
 * templates 4, plugins 11), so ordinary churn cannot trip them.
 */
const MIN_FILES: Readonly<Record<(typeof SCAN_ROOTS)[number], number>> = {
  src: 150,
  tests: 200,
  scripts: 10,
  bin: 2,
  templates: 2,
  plugins: 5,
};

/**
 * The environment-dumping commands, spelled without ever writing a
 * forbidden fragment as a literal in this file.
 *
 * The second name is composed rather than written, and `GT`/`PIPE` below
 * are built from char codes, for the same stated reason: this file is
 * scanned like every other and there is no exclusion list. Written out,
 * `["env", "printenv"]` is itself an argv-array match under the rule
 * added 2026-08-28 — which is the guard correctly applying to its own
 * source, and is fixed here the way the file already fixes every other
 * self-match, rather than with the carve-out that would blunt it.
 */
const DUMP_CMD = "env";
const DUMPERS = [DUMP_CMD, `print${DUMP_CMD}`];

const GT = String.fromCharCode(62); // ">"
const PIPE = String.fromCharCode(124); // "|"

/** Not a property access (`process.env`), a flag (`--env`), an identifier
 *  ending in the word (`myenv`), or a shell expansion (`$env`). Only the
 *  standalone COMMAND is a dump. */
const NOT_A_WORD_BEFORE = "(?<![\\w.$-])";

/**
 * Not the middle of a precedence chain.
 *
 * This repository's prose writes them as `flag > env > default` and its
 * help text as `per-call > env > the atmux on PATH`. Both put an arrow
 * immediately BEFORE the word, which no real redirect does — a shell
 * command is not itself the target of a redirect. Measured 2026-08-28:
 * this excludes every prose line in the repository (`src/verbs/help.ts`
 * is the only live one; the rest are comments, already skipped) and
 * excludes no real dump.
 */
const NOT_AFTER_ARROW = `(?<!${GT}\\s{0,4})`;

/**
 * A redirect target that looks like a path or an expansion — `${out}`,
 * `/tmp/x`, `"$D/out"`, `./out`, `~/x`.
 */
const PATH_LIKE_TARGET = "[\"'/~.$\\\\]";

/**
 * A redirect target that is a BARE relative filename — `env > out`.
 *
 * ADR-282 §D4 named this as a known gap and declined to close it, on the
 * grounds that it is indistinguishable from prose. It is distinguishable:
 * prose continues past the target into a sentence, a redirect ends the
 * statement. Requiring the end of a shell statement here, on top of
 * {@link NOT_AFTER_ARROW}, closes it.
 */
const BARE_TARGET_END = "[A-Za-z0-9_][\\w.-]*\\s*(?:;|&|\\)|$)";

/** A line whose trimmed text starts here is a comment. Comments do not
 *  execute, so a documented example of the forbidden shape is not a
 *  violation — and skipping them is not an exclusion list anyone can hide
 *  live code behind. */
const COMMENT_START = /^\s*(\/\/|\/\*|\*|#)/;

function offendingRegexes(): RegExp[] {
  return DUMPERS.flatMap((cmd) => [
    // `env > /tmp/x`, `env >> ${out}`, `env 2> "$D/out"`
    new RegExp(`${NOT_A_WORD_BEFORE}${cmd}\\s*[0-9]?${GT}${GT}?\\s*${PATH_LIKE_TARGET}`),
    // `env > out` — a bare relative filename, ADR-282's stated gap.
    new RegExp(
      `${NOT_AFTER_ARROW}${NOT_A_WORD_BEFORE}${cmd}\\s*[0-9]?${GT}${GT}?\\s*${BARE_TARGET_END}`,
    ),
    // `env | tee x`, `env | cat`, `env | sort | grep …` — piped anywhere
    // that is not grep. `(?!\\${PIPE})` keeps the JS `env || {}` idiom out.
    new RegExp(`${NOT_A_WORD_BEFORE}${cmd}\\s*\\${PIPE}\\s*(?!\\${PIPE})(?!grep\\b)[\\w./]`),
    // `env -0`, `env --null`, `["env", "-0"]` — the null-separated whole
    // dump. The flag says "all of it" whatever happens to the output, so
    // no redirect or pipe is needed to make this a capture.
    new RegExp(`${NOT_A_WORD_BEFORE}${cmd}["']?[\\s,]*["']?(?:-0|--null)\\b`),
    // `Bun.spawnSync({ cmd: ["env"] })` — the idiomatic TypeScript route,
    // and the one the first version of this matcher missed while the very
    // file it protects used it four times. The dumper as the LAST element
    // of an argv array is a whole dump; anywhere earlier it is a prefix
    // (`["env", "-u", "NO_COLOR", "tmux", …]`) or a single-variable read
    // (`["printenv", "TERM"]`), both of which are fine.
    new RegExp(`[\\[,]\\s*(["'\`])${cmd}\\1\\s*\\]`),
    // `$(env)` / backtick-env — command substitution captures stdout just
    // as surely as a redirect does.
    new RegExp(`\\$\\(\\s*${cmd}\\s*\\)`),
  ]);
}

const OFFENDERS = offendingRegexes();

function isOffending(line: string): boolean {
  if (COMMENT_START.test(line)) return false;
  return OFFENDERS.some((re) => re.test(line));
}

/** Should this file be read? Extension roster, plus extensionless files
 *  carrying a shebang — `bin/atmux` and `bin/atmux-tmux` are both
 *  executable scripts with no suffix. */
function isScannable(absPath: string, rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot > 0) return SCAN_EXTS.has(base.slice(dot));
  try {
    return readFileSync(absPath, "utf8").startsWith("#!");
  } catch {
    return false;
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const glob = new Bun.Glob("**/*");
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true, dot: false })) {
    if (rel.includes("node_modules/")) continue;
    const abs = join(dir, rel);
    if (!isScannable(abs, rel)) continue;
    out.push(abs);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** Scan `roots` (absolute paths). Parameterised so the honesty leg below
 *  can point it at a temp tree with a real violation in it, rather than
 *  writing one into the repository to prove the walk works. */
function scan(
  roots: ReadonlyArray<string> = SCAN_ROOTS.map((r) => join(REPO_ROOT, r)),
): Violation[] {
  const found: Violation[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (isOffending(text)) {
          found.push({
            file: file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file,
            line: i + 1,
            text: text.trim(),
          });
        }
      }
    }
  }
  return found;
}

describe("no unfiltered environment dump reaches an assertion (ADR-282)", () => {
  test("the scanned roots contain no whole-environment capture", () => {
    const violations = scan();
    const detail = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.text}`).join("\n");
    expect(
      violations,
      violations.length === 0
        ? ""
        : [
            "Unfiltered environment capture found (ADR-282).",
            "",
            detail,
            "",
            "A failing assertion prints its received value IN FULL. Route every",
            "environment probe through tests/helpers/env-dump.ts:",
            "    import { dumpEnvCommand, parseEnvDump } from '<path>/helpers/env-dump.ts';",
            "    shellCommand: dumpEnvCommand(outPath)   // greps an allowlist in the probe",
            "    const projection = parseEnvDump(await readFile(outPath, 'utf8'));",
          ].join("\n"),
    ).toEqual([]);
  });

  // ---- the guard's own honesty legs -------------------------------------
  //
  // A scanner that matches nothing is indistinguishable from a scanner
  // that is broken, and `scan()` returning `[]` says nothing on its own.
  // These pin the discovery half (`walk`, `scan`) as well as the matcher.

  test("the walk actually reaches files — every root over its floor", () => {
    const counts: Record<string, number> = {};
    const floors: Record<string, number> = {};
    for (const root of SCAN_ROOTS) {
      counts[root] = walk(join(REPO_ROOT, root)).length;
      floors[root] = MIN_FILES[root];
    }
    // Compared as objects so a failure prints which root collapsed and by
    // how much, rather than just "false is not true".
    const over: Record<string, boolean> = {};
    const expected: Record<string, boolean> = {};
    for (const root of SCAN_ROOTS) {
      over[root] = (counts[root] ?? 0) >= (floors[root] ?? 0);
      expected[root] = true;
    }
    expect({ over, counts }).toEqual({ over: expected, counts });
  });

  test("scan() finds a real violation planted in a tree it is pointed at", () => {
    // The end-to-end pin: walk → read → isOffending → Violation. A
    // discovery regression (an emptied SCAN_EXTS, a broken glob, an
    // unreadable root) turns this red, where the headline assertion above
    // would stay green. Written into a mktemp tree, never into the
    // repository, so a crashed run cannot leave a landmine behind.
    const dir = mkdtempSync(join(tmpdir(), "atmux-guard-"));
    try {
      writeFileSync(join(dir, "leak.sh"), `#!/bin/sh\n${DUMPERS[0]} ${GT} /tmp/x\n`, "utf8");
      writeFileSync(join(dir, "fine.ts"), `const a = 1;\n`, "utf8");
      const found = scan([dir]);
      expect(found.map((v) => ({ line: v.line, file: v.file.endsWith("leak.sh") }))).toEqual([
        { line: 2, file: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the matcher catches the shapes it exists to catch", () => {
    const caught = [
      `shellCommand: \`sh -c '${DUMPERS[0]} ${GT} \${out}; sleep 3'\`,`, // the 2026-08-28 leak, verbatim
      `${DUMPERS[0]}${GT}/tmp/x`, // no space
      `${DUMPERS[0]} ${GT}${GT} /tmp/x`, // append
      `${DUMPERS[0]} 2${GT} /tmp/x`, // fd-qualified redirect
      `${DUMPERS[0]} ${GT} "$D/out"`, // quoted expansion
      `${DUMPERS[0]} ${GT} ~/leak`,
      `${DUMPERS[0]} ${PIPE} tee /tmp/x`, // piped to something that is not grep
      `${DUMPERS[0]} ${PIPE}sort`, // no space
      `${DUMPERS[0]} ${PIPE} sort ${PIPE} grep -E "^TERM="`, // grep too late — already in the pipeline
      `${DUMPERS[1]} ${GT} /tmp/x`, // printenv is the same capability
      `${DUMPERS[1]} ${PIPE} cat`,
      // --- shapes the first version of this matcher MISSED (2026-08-28) ---
      `${DUMPERS[0]} ${GT} out`, // bare relative filename — ADR-282's stated gap
      `${DUMPERS[0]} ${GT}${GT} dump.txt;`, // …appended, statement-terminated
      `const r = Bun.spawnSync({ cmd: ["${DUMPERS[0]}"], stdout: "pipe" });`, // the idiomatic TS route
      `Bun.spawn({ cmd: ['${DUMPERS[1]}'] })`, // single quotes
      `cmd: [\`${DUMPERS[0]}\`],`, // backticks
      `spawnSync("sh", ["-c", "${DUMPERS[0]}"])`, // dumper last in the argv array
      `${DUMPERS[0]} -0 ${PIPE} xargs -0 echo`, // null-separated whole dump
      `${DUMPERS[0]} --null`,
      `cmd: ["${DUMPERS[0]}", "-0"]`, // …in argv form
      `${DUMPERS[1]} -0`,
      `const all = \`$(${DUMPERS[0]})\`;`, // command substitution
      `x=$(${DUMPERS[1]})`,
    ];
    for (const line of caught) {
      expect({ line, offending: isOffending(line) }).toEqual({ line, offending: true });
    }
  });

  test("the matcher does not punish the safe or unrelated shapes", () => {
    const allowed = [
      dumpEnvCommand("/tmp/x"), // the sanctioned helper output
      `${DUMPERS[0]} ${PIPE} grep -E "^(TERM)=" ${GT} /tmp/x`, // filtered at the source
      `${DUMPERS[1]} ${PIPE} grep TERM`,
      `${DUMPERS[0]} -u NO_COLOR tmux -S /tmp/s new-session`, // env(1) as a prefix, not a dump
      `cmd: ["${DUMPERS[0]}", "-u", "NO_COLOR", "tmux"]`, // …the same, in argv form
      `cmd: ["${DUMPERS[1]}", "TERM"]`, // a single-variable read
      `const merged = { ...process.env ${PIPE}${PIPE} {} };`, // property access, JS or-idiom
      `if (opts.env) return opts.env;`,
      `const e = env ${PIPE}${PIPE} {};`, // a local named env, or-idiom
      `x.env ${GT} /tmp/x`, // property access
      `--env ${GT} /tmp/x`, // a flag named env
      `myenv ${GT} /tmp/x`, // an identifier ending in env
      `$env ${GT} /tmp/x`, // a shell expansion, not the command
      "  per-call > env > the atmux on PATH; empty value", // help text, verbatim from src/verbs/help.ts
      "flag > env > default for a numeric knob", // a precedence chain in prose
      `//   FORBIDDEN   ${DUMPERS[0]} ${GT} /tmp/x`, // a comment cannot execute
      ` *  ${DUMPERS[0]} ${GT} /tmp/x`, // …including a block-comment continuation
      `# ${DUMPERS[0]} ${GT} /tmp/x`, // …and a shell comment
    ];
    for (const line of allowed) {
      expect({ line, offending: isOffending(line) }).toEqual({ line, offending: false });
    }
  });

  test("the sanctioned helper really does filter to the allowlist", () => {
    // Ties the guard's "safe alternative" advice to the thing it names:
    // if `dumpEnvCommand` ever stopped filtering, the advice would send
    // the next author straight back into the leak.
    const cmd = dumpEnvCommand("/tmp/x");
    expect(cmd).toContain(`grep -E "^(${ENV_DUMP_ALLOWLIST.join("|")})="`);
  });
});
