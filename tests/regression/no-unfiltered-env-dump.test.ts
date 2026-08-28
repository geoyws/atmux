// ADR-282 — no source or test file may capture the WHOLE environment.
//
// On 2026-08-28 a regression test ran a probe pane that redirected the
// full `env` output to a file, read it back, and asserted on the string.
// The assertion failed once, and `expect(received)` printed ~180 variables
// WITH THEIR VALUES — live API tokens, database and docs passwords,
// Discord webhook URLs — into the test log and into an agent transcript.
//
// The narrow repair (filter before asserting) leaves the class alive: the
// secrets still enter the test process, one careless `expect(raw)` away
// from print. This guard closes the class. It fails the suite if any file
// under `src/` or `tests/` captures an unfiltered environment dump.
//
// The rule is deliberately blunt rather than clever, because a rule an
// author can reason around is not a guard:
//
//   FORBIDDEN   env  >  file            (redirect of the whole thing)
//   FORBIDDEN   env  |  anything-else   (tee / head / cat / a pipeline)
//   ALLOWED     env  |  grep …          (filtered at the source)
//
// `printenv` is covered identically — it is the same capability under a
// different name, and leaving it out would make the guard a formality.
//
// Self-application: this file scans itself like every other, and there is
// NO path exclusion list. The forbidden fragments below are assembled from
// pieces at runtime precisely so that no carve-out is needed — a carve-out
// is the first thing a future author would reach for to get past the
// guard.
//
// The safe form lives in tests/helpers/env-dump.ts (`dumpEnvCommand`).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dumpEnvCommand, ENV_DUMP_ALLOWLIST } from "../helpers/env-dump.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Roots that get scanned. `src/` is included because a test helper (or a
 *  diagnostic verb) could just as easily dump an environment. */
const SCAN_ROOTS = ["src", "tests"] as const;

const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".bash", ".bats"]);

/** The environment-dumping commands, spelled without ever writing a
 *  forbidden fragment as a literal in this file. */
const DUMPERS = ["env", "printenv"];

const GT = String.fromCharCode(62); // ">"
const PIPE = String.fromCharCode(124); // "|"

/** Not a property access (`process.env`), a flag (`--env`), an identifier
 *  ending in the word (`myenv`), or a shell expansion (`$env`). Only the
 *  standalone COMMAND is a dump. */
const NOT_A_WORD_BEFORE = "(?<![\\w.$-])";

/**
 * A redirect only counts when its target looks like a path or an
 * expansion — `${out}`, `/tmp/x`, `"$D/out"`, `./out`, `~/x`.
 *
 * This is what separates a shell fragment from English. This repo's prose
 * writes precedence chains as `flag > env > default` and help text as
 * `per-call > env > the atmux on PATH`; every one of those has an ordinary
 * word after the arrow, and none of them runs anything. Measured
 * 2026-08-28: 12 such lines across `src/` and `tests/`, all prose, all
 * excluded by this class, zero real dumps excluded.
 *
 * Known gap, stated rather than papered over: a redirect to a BARE
 * relative filename (`env > out`) is not matched, because that is
 * indistinguishable from prose by this rule. No probe in this repo writes
 * one — they all use `mkdtemp` absolute paths or a `${...}` expansion —
 * and the pipe rule below has no such gap.
 */
const PATH_LIKE_TARGET = "[\"'/~.$\\\\]";

/** A line whose trimmed text starts here is a comment. Comments do not
 *  execute, so a documented example of the forbidden shape is not a
 *  violation — and skipping them is not an exclusion list anyone can hide
 *  live code behind. */
const COMMENT_START = /^\s*(\/\/|\/\*|\*|#)/;

function offendingRegexes(): RegExp[] {
  return DUMPERS.flatMap((cmd) => [
    // `env > /tmp/x`, `env >> ${out}`, `env 2> "$D/out"`
    new RegExp(`${NOT_A_WORD_BEFORE}${cmd}\\s*[0-9]?${GT}${GT}?\\s*${PATH_LIKE_TARGET}`),
    // `env | tee x`, `env | cat`, `env | sort | grep …` — piped anywhere
    // that is not grep. `(?!\\${PIPE})` keeps the JS `env || {}` idiom out.
    new RegExp(`${NOT_A_WORD_BEFORE}${cmd}\\s*\\${PIPE}\\s*(?!\\${PIPE})(?!grep\\b)[\\w./]`),
  ]);
}

const OFFENDERS = offendingRegexes();

function isOffending(line: string): boolean {
  if (COMMENT_START.test(line)) return false;
  return OFFENDERS.some((re) => re.test(line));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const glob = new Bun.Glob("**/*");
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true, dot: false })) {
    const dot = rel.lastIndexOf(".");
    if (dot < 0 || !SCAN_EXTS.has(rel.slice(dot))) continue;
    if (rel.includes("node_modules/")) continue;
    out.push(join(dir, rel));
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function scan(): Violation[] {
  const found: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (isOffending(text)) {
          found.push({ file: file.slice(REPO_ROOT.length + 1), line: i + 1, text: text.trim() });
        }
      }
    }
  }
  return found;
}

describe("no unfiltered environment dump reaches an assertion (ADR-282)", () => {
  test("src/ and tests/ contain no whole-environment capture", () => {
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
            "A failing assertion prints its received value IN FULL, and this",
            "runner's environment carries live tokens, passwords and webhook",
            "URLs. Do not filter after the fact — never collect it at all.",
            "",
            "Use tests/helpers/env-dump.ts instead:",
            "    import { dumpEnvCommand, parseEnvDump } from '<path>/helpers/env-dump.ts';",
            "    shellCommand: dumpEnvCommand(outPath)   // greps an allowlist in the probe",
            "    const projection = parseEnvDump(await readFile(outPath, 'utf8'));",
          ].join("\n"),
    ).toEqual([]);
  });

  // ---- the guard's own honesty legs -------------------------------------
  //
  // A scanner that matches nothing is indistinguishable from a scanner
  // that is broken. These pin the matcher itself against the exact shapes
  // it exists to catch, and against the shape it must NOT punish.

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
      `const merged = { ...process.env ${PIPE}${PIPE} {} };`, // property access, JS or-idiom
      `if (opts.env) return opts.env;`,
      `const e = env ${PIPE}${PIPE} {};`, // a local named env, or-idiom
      `x.env ${GT} /tmp/x`, // property access
      `--env ${GT} /tmp/x`, // a flag named env
      `myenv ${GT} /tmp/x`, // an identifier ending in env
      `$env ${GT} /tmp/x`, // a shell expansion, not the command
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
