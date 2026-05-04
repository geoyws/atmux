// Unit tests for src/abstractions/lock.ts (ADR-005).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, LIBC_PATHS, tryLoadFlock, withLock } from "../../../src/abstractions/lock.ts";
import { LockError, LockTimeoutError } from "../../../src/errors.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-lock-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("acquire / release", () => {
  test("single-process acquire + release succeeds", async () => {
    const target = join(dir, "single");
    const handle = await acquire(target);
    expect(handle.lockPath).toBe(`${target}.lock`);
    await handle.release();
  });

  test("release is idempotent", async () => {
    const target = join(dir, "rel");
    const handle = await acquire(target);
    await handle.release();
    await handle.release();
    expect(true).toBe(true);
  });

  test("creates parent dir when missing", async () => {
    const nested = join(dir, "a", "b", "c", "lockfile");
    const handle = await acquire(nested);
    expect(handle.lockPath).toBe(`${nested}.lock`);
    await handle.release();
  });

  test("re-acquire after release works", async () => {
    const target = join(dir, "reacquire");
    const a = await acquire(target);
    await a.release();
    const b = await acquire(target);
    await b.release();
    expect(true).toBe(true);
  });
});

describe("contention via subprocess", () => {
  // We need a SECOND OS process to actually contend (flock is process-level
  // on Linux/macOS — same-process re-acquire is a no-op). We spawn a child
  // that holds the lock for a known duration, then assert our acquire
  // either times out (short budget) or succeeds (long budget).

  test("acquire times out when held by another process", async () => {
    const target = join(dir, "contended");
    // Touch so the path exists for the child.
    await Bun.write(target, "init");
    const child = Bun.spawn([
      "bun",
      "-e",
      `
        const lock = await import("${process.cwd()}/src/abstractions/lock.ts");
        const h = await lock.acquire("${target}");
        await new Promise(r => setTimeout(r, 800));
        await h.release();
      `,
    ]);
    // Give the child time to grab the lock.
    await new Promise((r) => setTimeout(r, 200));
    let caught: LockTimeoutError | null = null;
    try {
      await acquire(target, { timeoutMs: 200, retryDelayMs: 30 });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.context.timeoutMs).toBe(200);
    await child.exited;
  });

  test("acquire succeeds after contender releases (long budget)", async () => {
    const target = join(dir, "wait-then-grab");
    await Bun.write(target, "init");
    const child = Bun.spawn([
      "bun",
      "-e",
      `
        const lock = await import("${process.cwd()}/src/abstractions/lock.ts");
        const h = await lock.acquire("${target}");
        await new Promise(r => setTimeout(r, 200));
        await h.release();
      `,
    ]);
    await new Promise((r) => setTimeout(r, 80));
    // Long budget — should succeed once child releases at ~200ms.
    const h = await acquire(target, { timeoutMs: 2000, retryDelayMs: 30 });
    await h.release();
    await child.exited;
    expect(true).toBe(true);
  });
});

describe("tryLoadFlock (libc walk)", () => {
  test("falls through to a working entry after a bogus first candidate", () => {
    const syms = tryLoadFlock(["definitely-not-a-libc-xyz.so", ...LIBC_PATHS]);
    expect(typeof syms.flock).toBe("function");
  });

  test("throws LockError when every candidate fails", () => {
    expect(() => tryLoadFlock(["no-such-1.so", "no-such-2.so", "no-such-3.so"])).toThrow(LockError);
  });
});

describe("withLock", () => {
  test("returns fn's value when fn resolves", async () => {
    const target = join(dir, "withlock-ok");
    const got = await withLock(target, () => "answer");
    expect(got).toBe("answer");
  });

  test("supports async fn", async () => {
    const target = join(dir, "withlock-async");
    const got = await withLock(target, async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    expect(got).toBe(42);
  });

  test("releases lock even when fn throws", async () => {
    const target = join(dir, "withlock-throws");
    let caught: Error | null = null;
    try {
      await withLock(target, () => {
        throw new Error("boom");
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("boom");
    // Subsequent acquire must succeed (proves lock was released).
    const h = await acquire(target, { timeoutMs: 200 });
    await h.release();
  });

  test("forwards opts to acquire (timeout)", async () => {
    const target = join(dir, "withlock-opts");
    await Bun.write(target, "init");
    const child = Bun.spawn([
      "bun",
      "-e",
      `
        const lock = await import("${process.cwd()}/src/abstractions/lock.ts");
        const h = await lock.acquire("${target}");
        await new Promise(r => setTimeout(r, 800));
        await h.release();
      `,
    ]);
    await new Promise((r) => setTimeout(r, 200));
    let caught: LockTimeoutError | null = null;
    try {
      await withLock(target, () => "never", { timeoutMs: 150, retryDelayMs: 30 });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
    await child.exited;
  });
});
