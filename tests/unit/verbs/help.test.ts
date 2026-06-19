// Unit tests for src/verbs/help.ts (ADR-010).
// Tracked under the ADR-009 §2 narrowed denominator (`src/verbs/**/*.ts`)
// — 100% line/function/branch coverage required.
//
// `help` prints the usage block and exits 0. Tests pin both observables
// (the literal stdout payload + the exit code). The earlier byte-match-
// against-bash heredoc test was removed when bin/atmux became a pure bun
// shim (lib/*.sh decommissioned per ADR-064); the bash counterpart no
// longer exists, so spot-check substrings + the trailing-newline
// invariant cover the remaining shape.

import { describe, expect, test } from "bun:test";
import { ATMUX_USAGE, help } from "../../../src/verbs/help.ts";

describe("verbs/help", () => {
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
    expect(ATMUX_USAGE.startsWith("atmux — tmux agent harness + task feed (ADR-263).\n")).toBe(
      true,
    );
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
