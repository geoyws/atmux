// Unit tests for src/core/io.ts (ADR-020).
//
// Three concerns:
//   1. defaultStdoutWrite forwards to process.stdout.write — pin the
//      pass-through by stubbing process.stdout.write and asserting the
//      stub saw the exact byte string.
//   2. defaultStderrWrite forwards to process.stderr.write — same shape.
//   3. Writer + IoSinks are types — pinned via a structural-assignability
//      compile-time check (the test body wires a stub through both
//      interfaces; if either type drifted to incompatible shapes, `bunx
//      tsc --noEmit` would fail before this test runs).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultStderrWrite,
  defaultStdoutWrite,
  type IoSinks,
  type Writer,
} from "../../../src/core/io.ts";

describe("defaultStdoutWrite — process.stdout.write passthrough", () => {
  let captured = "";
  let origWrite: typeof process.stdout.write;

  beforeEach(() => {
    captured = "";
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
  });

  test("forwards the input verbatim and returns the boolean", () => {
    const ret = defaultStdoutWrite("hello world\n");
    expect(captured).toBe("hello world\n");
    expect(ret).toBe(true);
  });
});

describe("defaultStderrWrite — process.stderr.write passthrough", () => {
  let captured = "";
  let origWrite: typeof process.stderr.write;

  beforeEach(() => {
    captured = "";
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string | Uint8Array) => {
      captured += typeof s === "string" ? s : new TextDecoder().decode(s);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
  });

  test("forwards the input verbatim and returns the boolean", () => {
    const ret = defaultStderrWrite("warn: boom\n");
    expect(captured).toBe("warn: boom\n");
    expect(ret).toBe(true);
  });
});

describe("Writer + IoSinks — structural typing", () => {
  test("Writer accepts a (s: string) => void stub", () => {
    let buf = "";
    const w: Writer = (s) => {
      buf += s;
    };
    w("a");
    w("b");
    expect(buf).toBe("ab");
  });

  test("Writer accepts process.stdout.write's boolean-returning shape", () => {
    // The Writer contract relaxes the return to `void`, but boolean
    // widens to void — this assignment must compile.
    const w: Writer = defaultStdoutWrite;
    expect(typeof w).toBe("function");
  });

  test("IoSinks fields are optional", () => {
    const empty: IoSinks = {};
    const justStdout: IoSinks = { stdout: () => {} };
    const both: IoSinks = { stdout: () => {}, stderr: () => {} };
    expect(empty.stdout).toBeUndefined();
    expect(justStdout.stdout).toBeDefined();
    expect(both.stdout).toBeDefined();
    expect(both.stderr).toBeDefined();
  });
});
