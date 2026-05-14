// Unit tests for src/verbs/version.ts (ADR-010).
// Tracked under the ADR-009 §2 narrowed denominator (`src/verbs/**/*.ts`)
// — 100% line/function/branch coverage required.
//
// Drift-class killer: ATMUX_VERSION is read from package.json at
// runtime, so the parity assertion is structural (constants match the
// JSON file) rather than a hardcoded literal. Bumping
// package.json::version is the single source of truth.

import { describe, expect, test } from "bun:test";
import pkg from "../../../package.json" with { type: "json" };
import { ATMUX_VERSION, version } from "../../../src/verbs/version.ts";

describe("verbs/version", () => {
  test("ATMUX_VERSION constant matches package.json::version at runtime", () => {
    // Structural parity — both sides resolve to the same JSON read at
    // import time. If a future refactor decouples them, this fails.
    expect(ATMUX_VERSION).toBe(pkg.version);
  });

  test("ATMUX_VERSION is a non-empty semver-shaped string", () => {
    // Cheap shape guard so a malformed package.json (empty / missing
    // version field) fails the suite rather than shipping a binary
    // that prints `atmux undefined`.
    expect(ATMUX_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("version() returns exit code 0", async () => {
    // Capture stdout via console.log redirection; verify the literal
    // line emitted. Args are ignored (parity requirement — see
    // version.ts docstring), so empty + non-empty arg arrays must
    // produce identical behaviour.
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
    // <ver>` and exits 0. The TS verb signature accepts a
    // ReadonlyArray and discards it; this test pins that contract.
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
