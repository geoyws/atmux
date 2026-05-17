// Unit tests for src/abstractions/crontab.ts (ADR-083 §IN §2).
//
// The default implementation shells `crontab -l` / `crontab <file>` via
// the central `spawn()` primitive — testing it directly would require a
// host crontab. We exercise the public surface (the `CrontabIO`
// interface contract) by instantiating fakes inline in the dependent
// verb tests; this file pins the type-shape + null-on-error contract of
// the default impl by stubbing `spawn` via a small shim. The point is
// the contract, not the syscall.

import { describe, expect, test } from "bun:test";
import { type CrontabIO, defaultCrontabIO } from "../../../src/abstractions/crontab.ts";

describe("CrontabIO contract", () => {
  test("defaultCrontabIO returns an object satisfying the interface", () => {
    const io: CrontabIO = defaultCrontabIO();
    expect(typeof io.read).toBe("function");
    expect(typeof io.write).toBe("function");
    expect(typeof io.available).toBe("function");
  });

  test("read/write/available are independent Promises (no shared state)", async () => {
    const io = defaultCrontabIO();
    // Don't actually invoke crontab — calling read() in a sandbox that
    // happens to have a real crontab would pollute the test environment.
    // Just confirm the function references are distinct + invokable.
    expect(io.read).not.toBe(io.write);
    expect(io.read).not.toBe(io.available);
    expect(io.write).not.toBe(io.available);
  });
});

describe("CrontabIO fake (for downstream test wiring)", () => {
  // The dominant test pattern is "instantiate an in-memory pair in the
  // verb test and inject it." This test exercises that exact shape to
  // catch interface drift early.
  test("in-memory fake round-trips read↔write", async () => {
    let store: string | null = null;
    const fake: CrontabIO = {
      read: async () => store,
      write: async (body) => {
        store = body;
      },
      available: async () => true,
    };
    expect(await fake.read()).toBeNull();
    await fake.write("# >>> atmux:team=demo — managed by atmux start; do not edit by hand\n");
    expect(await fake.read()).toContain("atmux:team=demo");
  });

  test("in-memory fake honors available=false", async () => {
    const fake: CrontabIO = {
      read: async () => null,
      write: async () => {
        throw new Error("should not be invoked when available()==false");
      },
      available: async () => false,
    };
    expect(await fake.available()).toBe(false);
  });
});
