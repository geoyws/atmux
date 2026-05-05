// ADR-010: CLI dispatcher.
// ADR-006: top-level error mapping (tag → BSD sysexits).
//
// Phase-1 minimal: routes the `version` verb (smallest state, first
// parity-harness verb per task #4). Unknown verbs throw `UsageError`,
// caught by the top-level handler which maps it to exit 64 (EX_USAGE)
// with a two-line bash-format stderr matching `bin/atmux:324-328`:
//
//   atmux: unknown verb: <verb>
//     run 'atmux help' for the list of verbs
//
// (Note on hint indent: bash uses 2-space; ADR-006 §"Top-level catch"
// sketches 7-space — bash parity wins here. The ADR's sketch was not
// strict, just illustrative; nothing else relies on the indent width.)
//
// `reportError` covers every ADR-006 error class so Phase 2 verbs that
// throw typed errors (FsError, TmuxError, etc.) get correct sysexits
// without further dispatcher work. Exported for direct unit testing
// (test naming convention: function exported AS-IS rather than `_`-
// prefixed because future verbs may legitimately call it for re-raise
// formatting; not test-only).
//
// Phase 2 expands the dispatch switch as porters land additional
// verbs; alias routing follows per ADR-014.
//
// **Pure library** — no module-level side effects. The TS entrypoint
// is `bin/atmux-bun` (excluded from the coverage denominator per its
// `bin/` path); running `bun run src/cli.ts <verb>` directly is NOT
// supported. This keeps `src/cli.ts` 100% unit-testable per ADR-009 §2.

import { AtmuxError, exitCodeForTag, formatErrorChain, UsageError } from "./errors.ts";
import { addMember } from "./verbs/add-member.ts";
import { attach } from "./verbs/attach.ts";
import { init } from "./verbs/init.ts";
import { start } from "./verbs/start.ts";
import { version } from "./verbs/version.ts";

/**
 * Entry point — process argv (sliced past binary + script name) and
 * return the exit code. Wraps `dispatch` in a top-level catch that
 * maps ADR-006-tagged errors to BSD sysexits (`UsageError` → 64,
 * `*-timeout` → 75, `ConfigError` → 78, etc.). Anything not an
 * `AtmuxError` is treated as a programmer bug → exit 99 + stack.
 */
export async function main(argv: ReadonlyArray<string>): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (err) {
    return reportError(err);
  }
}

/**
 * Verb-table dispatch. Throws `UsageError` on unknown verb so the
 * exit code (64) flows through `reportError` rather than being a
 * dispatcher-special case.
 */
async function dispatch(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0] ?? "";
  switch (verb) {
    case "version":
    case "--version":
    case "-V":
      return version(argv.slice(1));
    case "init":
      return init(argv.slice(1));
    case "start":
      return start(argv.slice(1));
    case "attach":
      return attach(argv.slice(1));
    case "add-member":
      return addMember(argv.slice(1));
    default:
      throw new UsageError({
        what: `unknown verb: ${verb || "<none>"}`,
        hint: "run 'atmux help' for the list of verbs",
      });
  }
}

/**
 * Map an error to stderr output + exit code per ADR-006 §"Top-level
 * catch":
 *
 * - `UsageError` → `atmux: <what>` + 2-space-indented hint (if any),
 *   exit 64. Byte-matches bash `bin/atmux:324-328`.
 * - Other `AtmuxError` → `atmux: <tag>: <message>`, exit per
 *   `exitCodeForTag`. With `ATMUX_DEBUG=1` the full `cause` chain
 *   follows on stderr (per `formatErrorChain`).
 * - Anything else (programmer error / non-Error throw) →
 *   `atmux: internal error` + stack (or `String(err)`), exit 99.
 *
 * Exported so each branch can be unit-tested directly without wiring
 * a fake verb that throws each error type — every Phase 2 verb that
 * throws an `AtmuxError` exercises the same paths via `main()`.
 */
export function reportError(err: unknown): number {
  if (err instanceof UsageError) {
    const ctx = err.context as { what: string; hint?: string };
    process.stderr.write(`atmux: ${ctx.what}\n`);
    if (ctx.hint !== undefined && ctx.hint !== "") {
      process.stderr.write(`  ${ctx.hint}\n`);
    }
    return 64;
  }
  if (err instanceof AtmuxError) {
    process.stderr.write(`atmux: ${err.tag}: ${err.message}\n`);
    const debug = process.env.ATMUX_DEBUG;
    if (debug !== undefined && debug !== "") {
      process.stderr.write(formatErrorChain(err));
    }
    return exitCodeForTag(err.tag);
  }
  process.stderr.write("atmux: internal error\n");
  if (err instanceof Error) {
    process.stderr.write(`${err.stack ?? err.message}\n`);
  } else {
    process.stderr.write(`${String(err)}\n`);
  }
  return 99;
}
