// Unit tests for src/verbs/version.ts (ADR-010).
// Tracked under the ADR-009 §2 narrowed denominator (`src/verbs/**/*.ts`)
// — 100% line/function/branch coverage required.
//
// The `version` verb is the smallest verb in the codebase: prints the
// version string, exits 0. These tests pin both observables (the literal
// string emitted to stdout + the exit code) so the parity harness's
// expectations stay in sync if anyone refactors `version.ts`.

import { describe, expect, test } from "bun:test";
import { ATMUX_VERSION, version } from "../../../src/verbs/version.ts";

describe("verbs/version", () => {
  test("ATMUX_VERSION constant matches bash@2aadc3f (atmux::version → 0.4.1)", () => {
    // Pinning the value here means a bump that desyncs from bash (which
    // emits `atmux 0.4.1` from `lib/common.sh::atmux::version`) breaks
    // this test BEFORE parity-harness CI catches it. Faster signal.
    expect(ATMUX_VERSION).toBe("0.4.1");
  });

  test("version() returns exit code 0", async () => {
    // Capture stdout via console.log redirection; verify the literal
    // line bash also emits. Args are ignored by both bash + ts (parity
    // requirement — see version.ts docstring), so empty + non-empty
    // arg arrays must produce identical behaviour.
    const captured: string[] = [];
    const orig = console.log;
    console.log = (msg: unknown) => {
      captured.push(String(msg));
    };
    try {
      const exit = await version([]);
      expect(exit).toBe(0);
      expect(captured).toEqual([`atmux ${ATMUX_VERSION}`]);
    } finally {
      console.log = orig;
    }
  });

  test("version() ignores extra args (parity with bash)", async () => {
    // Bash side: `bin/atmux version foo bar baz` still prints `atmux
    // 0.4.1` and exits 0. The TS verb signature accepts a ReadonlyArray
    // and discards it; this test pins that contract.
    const captured: string[] = [];
    const orig = console.log;
    console.log = (msg: unknown) => {
      captured.push(String(msg));
    };
    try {
      const exit = await version(["foo", "bar", "baz"]);
      expect(exit).toBe(0);
      expect(captured).toEqual([`atmux ${ATMUX_VERSION}`]);
    } finally {
      console.log = orig;
    }
  });
});
