// Unit tests for src/verbs/help.ts (ADR-010).
// Tracked under the ADR-009 §2 narrowed denominator (`src/verbs/**/*.ts`)
// — 100% line/function/branch coverage required.
//
// `help` is the second-smallest verb (after `version`): prints the
// usage heredoc and exits 0. Tests pin both observables (the literal
// stdout payload + the exit code) so the parity harness's expectations
// stay in sync if anyone refactors `help.ts`. The usage string is
// asserted in TWO ways:
//
//   1. Byte-exact length + a few invariant substrings to catch any
//      accidental edit (whitespace, trailing newline, version-stamp
//      drift).
//   2. Byte-exact equality against the bash heredoc payload, sourced
//      directly from `bin/atmux:26-85`. If bash drifts, this fails
//      BEFORE the parity-harness CI catches it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATMUX_USAGE, help } from "../../../src/verbs/help.ts";

/**
 * Extract bash's usage payload from `bin/atmux` — lines BETWEEN
 * `cat <<'EOF'` and the closing `EOF`. Re-derived on every run so a
 * bash-side edit fails this test fast (matches the version.test.ts
 * "pin bash-derived constant here" pattern).
 */
function bashUsageFromBin(): string {
  const binPath = join(import.meta.dir, "../../../bin/atmux");
  const src = readFileSync(binPath, "utf8");
  const start = src.indexOf("cat <<'EOF'\n");
  if (start < 0) throw new Error("bin/atmux: missing 'cat <<EOF' marker");
  const afterStart = start + "cat <<'EOF'\n".length;
  const end = src.indexOf("\nEOF\n", afterStart);
  if (end < 0) throw new Error("bin/atmux: missing closing EOF marker");
  // Heredoc content + the trailing newline before the EOF terminator.
  return `${src.slice(afterStart, end)}\n`;
}

describe("verbs/help", () => {
  test("ATMUX_USAGE byte-matches bash bin/atmux heredoc payload", () => {
    // Pinning byte-equality here means a bash-side or TS-side edit that
    // desyncs the two breaks this test BEFORE the parity-harness CI
    // catches it (faster signal). If this fails, fix whichever side
    // drifted; do not loosen the assertion.
    expect(ATMUX_USAGE).toBe(bashUsageFromBin());
  });

  test("ATMUX_USAGE ends with a single trailing newline", () => {
    // Bash's heredoc convention emits a trailing newline; pinning this
    // explicitly catches accidental `.trim()` regressions.
    expect(ATMUX_USAGE.endsWith("\n")).toBe(true);
    expect(ATMUX_USAGE.endsWith("\n\n")).toBe(false);
  });

  test("ATMUX_USAGE includes the canonical first + last lines", () => {
    // Defence-in-depth alongside the byte-exact match: spot-check the
    // top + bottom of the block so a future refactor that splits the
    // string into pieces can't accidentally drop the header / footer.
    expect(ATMUX_USAGE.startsWith("atmux — agent teams multiplexer.\n")).toBe(true);
    expect(ATMUX_USAGE).toContain("Docs:  https://github.com/geoyws/atmux\n");
  });

  test("help() returns exit code 0 + writes USAGE to stdout", async () => {
    // Capture process.stdout.write (NOT console.log — help.ts uses
    // stdout.write directly to avoid console.log's auto-newline append,
    // which would double the trailing newline). Verify exit 0 + the
    // payload byte-matches ATMUX_USAGE.
    let stdoutBuf = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await help([]);
      expect(exit).toBe(0);
      expect(stdoutBuf).toBe(ATMUX_USAGE);
    } finally {
      process.stdout.write = orig;
    }
  });

  test("help() ignores extra args (parity with bash)", async () => {
    // Bash side: `bin/atmux help foo bar baz` still prints the usage
    // and exits 0 (the dispatcher routes via `case "$1"` without
    // inspecting $2..). Pin that contract on the TS side.
    let stdoutBuf = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await help(["foo", "bar", "baz"]);
      expect(exit).toBe(0);
      expect(stdoutBuf).toBe(ATMUX_USAGE);
    } finally {
      process.stdout.write = orig;
    }
  });
});
