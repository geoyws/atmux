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
// capture" is undecidable in the direction that matters.
//
// THE MEASURED RATIO. Re-enumerated first-hand 2026-08-29 over 36 genuine
// whole-environment-capture shapes: this matcher catches **23 and misses
// 13**. Both halves are pinned by the "catch/miss ratio is measured, not
// assumed" leg below, so this number cannot drift away from the code. The
// missed 13, by class:
//
//   - 5x RUNTIME OBJECT — `console.log(process.env)`, `JSON.stringify`,
//     `{ ...process.env }`, `Object.entries`, a snapshot assertion. Missed
//     BY DESIGN, not by oversight: `process.env` is read legitimately all
//     over `src/`, so matching it would be all false positives.
//   - 3x SHELL BUILTIN — `export -p`, `declare -x`, `set`. Each prints the
//     environment as surely as `env` does, and none is in `DUMPERS`.
//   - 1x KERNEL INTERFACE — `cat /proc/self/environ` (Linux).
//   - 1x PROCESS TABLE — `ps eww <pid>`.
//   - 1x QUOTED SHELL WORD — `sh -c "env" > file`: the redirect sits
//     outside the quotes, so neither the redirect nor the argv rule fires.
//   - 1x LINE-SPLIT ARGV — the scan is LINE-ORIENTED, so an argv array
//     broken across lines is not matched.
//   - 1x RUNTIME ASSEMBLY — a command built by concatenation, held in a
//     variable, or `eval`'d is invisible to a source scan by construction.
//
// The alternate-dumper class (the first four groups) is the one an earlier
// residual-gaps list omitted entirely, which is how a guard comes to be
// trusted for more than it does.
//
// So: catch the mistake early, at the place it is written, with a message
// naming the safe route. Do not read a green run as an absence proof.
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
 * and `plugins/` were added 2026-08-28.
 *
 * ⚠ The reason first given for the four new roots — "every one of them
 * carries executable shell" — was FALSE of `templates/`, and the false
 * reason hid a live blind spot. Measured 2026-08-29: `templates/` holds
 * no `.sh`, `.bash` or `.bats` file at all. What it holds is 4 `.js`
 * files and `templates/tmux/atmux.conf`, and the `.conf` was UNSCANNABLE
 * because `.conf` was not in {@link SCAN_EXTS} — so the one file this
 * repository's colour work actually edits was the one file the guard
 * could not read.
 *
 * The true reason to scan `templates/`: a tmux conf executes shell.
 * Measured 2026-08-29 on tmux 3.7c against a throwaway `mktemp` socket —
 * a conf containing `run-shell "echo … > <marker>"` wrote the marker, so
 * `run-shell` in a shipped conf is live code, not configuration data.
 *
 * `scripts/` and `bin/` are also outside biome's `files.includes`, so
 * nothing else in the repository reads them at all.
 */
const SCAN_ROOTS = ["src", "tests", "scripts", "bin", "templates", "plugins"] as const;

/**
 * Extensions read by the walk.
 *
 * `.conf` is here because of the blind spot above. The roster is checked
 * against what the scanned roots actually contain by the
 * "no scannable-looking extension is silently skipped" leg below, so an
 * extension that appears in a scanned root cannot go unnoticed again.
 */
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".bash", ".bats", ".conf"]);

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

/**
 * Whole-environment capture shapes this matcher IS expected to catch.
 *
 * Module-level so the "catches what it exists to catch" leg and the
 * measured catch/miss ratio leg read the same list — a ratio computed
 * over a list only one of them can see is not a measurement.
 */
const CAUGHT_SHAPES: ReadonlyArray<string> = [
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
    for (const line of CAUGHT_SHAPES) {
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

  test("the matcher's catch/miss ratio is measured, not assumed", () => {
    // Re-enumerated first-hand 2026-08-29 rather than inherited from a
    // review. Every entry below is a genuine whole-environment capture;
    // the split records which ones this matcher sees. The ratio in this
    // file's header is THIS number, and it moves only when this list does.
    //
    // The missed entries are composed from pieces for the same reason the
    // caught ones are: this file is scanned like every other, and a
    // widened matcher must not turn its own fixtures into violations.
    const PROC = ["/proc", "self", "environ"].join("/");
    const PROCESS_ENV = `process.${DUMP_CMD}`;
    const missed: Array<[string, string]> = [
      // --- alternate dumper COMMANDS: the whole class the matcher's
      //     `DUMPERS` roster does not contain. Each prints the exported
      //     environment as surely as `env` does.
      ["shell builtin", `export -p ${GT} /tmp/x`],
      ["shell builtin", `declare -x ${GT} /tmp/x`],
      ["shell builtin", `set ${GT} /tmp/x`],
      ["kernel interface", `cat ${PROC} ${GT} /tmp/x`],
      ["process table", `ps eww $$ ${GT} /tmp/x`],
      // --- the dumper inside a quoted shell word rather than an argv
      //     element: the redirect sits outside the quotes, so neither the
      //     redirect rule nor the argv rule sees a dump.
      ["quoted shell word", `sh -c "${DUMP_CMD}" ${GT} /tmp/x`],
      // --- whole-object captures of the runtime's own environment view.
      //     Uncatchable here BY DESIGN, not by oversight: `process.env` is
      //     read legitimately all over `src/`, and `NOT_A_WORD_BEFORE`
      //     excludes it on purpose. See the "safe shapes" leg, which
      //     requires the spread form to stay legal.
      ["runtime object", `console.log(${PROCESS_ENV})`],
      ["runtime object", `JSON.stringify(${PROCESS_ENV})`],
      ["runtime object", `const all = { ...${PROCESS_ENV} };`],
      ["runtime object", `Object.entries(${PROCESS_ENV})`],
      ["runtime object", `expect(${PROCESS_ENV}).toMatchSnapshot()`],
      // --- the two gaps this file's header already names.
      ["line-split argv", `  "${DUMP_CMD}",`],
      ["runtime assembly", `const c = "en" + "v"; Bun.spawn({ cmd: [c] });`],
    ];

    const caughtCount = CAUGHT_SHAPES.filter(isOffending).length;
    const missedResults = missed.map(([cls, line]) => ({
      cls,
      line,
      offending: isOffending(line),
    }));

    // Every "caught" shape must be caught and every "missed" shape must
    // be missed — otherwise the ratio quoted in the header is fiction.
    expect({
      caught: caughtCount,
      enumerated: CAUGHT_SHAPES.length + missed.length,
      missedStillMissed: missedResults.filter((r) => r.offending),
    }).toEqual({
      caught: CAUGHT_SHAPES.length,
      enumerated: CAUGHT_SHAPES.length + missed.length,
      missedStillMissed: [],
    });
  });

  test("no scannable-looking extension in a scanned root is silently skipped", () => {
    // The `.conf` blind spot, pinned. `templates/tmux/atmux.conf` — the
    // file this repository's colour work edits — was unreadable to the
    // walk because `.conf` was not in SCAN_EXTS, while the roots' stated
    // justification claimed they "all carry executable shell". A tmux
    // conf DOES execute shell (`run-shell`), so the file was both live
    // code and invisible.
    //
    // This enumerates the extensions actually present and requires every
    // one that can execute to be scanned, so the next such file cannot
    // slip in behind a stale roster.
    const EXECUTABLE_EXTS = new Set([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".cjs",
      ".sh",
      ".bash",
      ".bats",
      ".conf",
    ]);
    const present = new Set<string>();
    for (const root of SCAN_ROOTS) {
      const glob = new Bun.Glob("**/*");
      for (const rel of glob.scanSync({
        cwd: join(REPO_ROOT, root),
        onlyFiles: true,
        dot: false,
      })) {
        if (rel.includes("node_modules/")) continue;
        const base = rel.slice(rel.lastIndexOf("/") + 1);
        const dot = base.lastIndexOf(".");
        if (dot > 0) present.add(base.slice(dot));
      }
    }
    const executablePresent = [...present].filter((e) => EXECUTABLE_EXTS.has(e)).sort();
    const unscanned = executablePresent.filter((e) => !SCAN_EXTS.has(e));
    expect({ unscanned, executablePresent }).toEqual({ unscanned: [], executablePresent });
  });

  test("the sanctioned helper really does filter to the allowlist", () => {
    // Ties the guard's "safe alternative" advice to the thing it names:
    // if `dumpEnvCommand` ever stopped filtering, the advice would send
    // the next author straight back into the leak.
    const cmd = dumpEnvCommand("/tmp/x");
    expect(cmd).toContain(`grep -E "^(${ENV_DUMP_ALLOWLIST.join("|")})="`);
  });
});
