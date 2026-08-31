// Unit tests for src/abstractions/lock.ts (ADR-005).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquire,
  acquireWithTTL,
  LIBC_PATHS,
  readLockOwnerPid,
  tryLoadFlock,
  withLock,
} from "../../../src/abstractions/lock.ts";
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

// ---------- ADR-057 §D3a + D3b — PID-bearing locks + TTL recovery ----------

describe("ADR-057 §D3b — PID-bearing locks", () => {
  test("acquire writes the owner PID to the lock file", async () => {
    const target = join(dir, "pid-target");
    const handle = await acquire(target);
    try {
      const pid = await readLockOwnerPid(handle.lockPath);
      expect(pid).toBe(process.pid);
    } finally {
      await handle.release();
    }
  });

  test("readLockOwnerPid returns null on absent file", async () => {
    expect(await readLockOwnerPid(join(dir, "nope.lock"))).toBeNull();
  });

  test("readLockOwnerPid returns null on empty file", async () => {
    const lockPath = join(dir, "empty.lock");
    await writeFile(lockPath, "");
    expect(await readLockOwnerPid(lockPath)).toBeNull();
  });

  test("readLockOwnerPid returns null on garbage content", async () => {
    const lockPath = join(dir, "garbage.lock");
    await writeFile(lockPath, "not-a-pid\n");
    expect(await readLockOwnerPid(lockPath)).toBeNull();
  });

  test("readLockOwnerPid handles multi-digit PIDs", async () => {
    const lockPath = join(dir, "big.lock");
    await writeFile(lockPath, "999999\n");
    expect(await readLockOwnerPid(lockPath)).toBe(999_999);
  });
});

describe("ADR-057 §D3a — acquireWithTTL crashed-PID recovery", () => {
  test("acquireWithTTL on a fresh lock works like acquire (writes PID)", async () => {
    const target = join(dir, "ttl-fresh");
    const handle = await acquireWithTTL(target);
    try {
      const pid = await readLockOwnerPid(handle.lockPath);
      expect(pid).toBe(process.pid);
    } finally {
      await handle.release();
    }
  });

  test("ownerPid override is honored", async () => {
    const target = join(dir, "ttl-pid-override");
    const handle = await acquireWithTTL(target, { ownerPid: 42 });
    try {
      expect(await readLockOwnerPid(handle.lockPath)).toBe(42);
    } finally {
      await handle.release();
    }
  });

  test("contended lock + dead PID + age > TTL → audit-logged (no force-release)", async () => {
    const target = join(dir, "orphan");
    const lockPath = `${target}.lock`;
    const auditDir = join(dir, "logs");

    // Spawn a child that holds the actual flock, then overwrite the
    // PID file with a "dead" PID + old mtime to fake the orphan
    // scenario (the recovery code reads the PID file independently of
    // the flock holder).
    const child = Bun.spawn([
      "bun",
      "-e",
      `
        const lock = await import("${process.cwd()}/src/abstractions/lock.ts");
        const h = await lock.acquire("${target}");
        await new Promise(r => setTimeout(r, 1500));
        await h.release();
      `,
    ]);
    await new Promise((r) => setTimeout(r, 200));

    // Overwrite the PID file with the stale dead PID.
    await writeFile(lockPath, "12345\n");
    const oldEpoch = Date.now() / 1000 - 600; // 10min ago
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, oldEpoch, oldEpoch);

    let caught: LockTimeoutError | null = null;
    try {
      await acquireWithTTL(target, {
        ttlSec: 300,
        isAlive: (pid) => pid !== 12345, // 12345 is "dead"
        auditDir,
        timeoutMs: 200,
        retryDelayMs: 30,
      });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    // Real flock contention → still times out.
    expect(caught).not.toBeNull();
    // But the audit-log entry was written.
    const auditLog = join(auditDir, "lock-recovery.log");
    const text = await readFile(auditLog, "utf8");
    expect(text).toContain(lockPath);
    expect(text).toContain("prev_pid=12345");
    expect(text).toContain("reason=ttl-orphan");
    await child.exited;
  });

  test("orphan lock from dead PID but age < TTL → NOT recovered (waits + times out)", async () => {
    const target = join(dir, "young-orphan");
    const lockPath = `${target}.lock`;
    await writeFile(lockPath, "12345\n");
    // Recent mtime — under TTL.
    // Hold the actual flock from a child process so the wait-with-retry
    // path engages instead of immediately succeeding.
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
      await acquireWithTTL(target, {
        ttlSec: 300,
        isAlive: (pid) => pid !== 12345,
        timeoutMs: 200,
        retryDelayMs: 30,
      });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
    await child.exited;
  });

  test("live owner → no force-release; standard wait-with-retry semantics", async () => {
    const target = join(dir, "live-owner");
    // Hold the actual flock from a child + write its real PID.
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
      await acquireWithTTL(target, {
        ttlSec: 0, // even past-TTL → live PID still wins
        isAlive: () => true, // claim every PID alive
        timeoutMs: 200,
        retryDelayMs: 30,
      });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
    await child.exited;
  });

  test("recovery without auditDir is silent (no log file written)", async () => {
    const target = join(dir, "silent-recovery");
    const lockPath = `${target}.lock`;
    const auditDir = join(dir, "logs-silent");

    // Same contended-orphan setup as above, but no auditDir passed.
    const child = Bun.spawn([
      "bun",
      "-e",
      `
        const lock = await import("${process.cwd()}/src/abstractions/lock.ts");
        const h = await lock.acquire("${target}");
        await new Promise(r => setTimeout(r, 1500));
        await h.release();
      `,
    ]);
    await new Promise((r) => setTimeout(r, 200));
    await writeFile(lockPath, "12345\n");
    const oldEpoch = Date.now() / 1000 - 600;
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, oldEpoch, oldEpoch);

    let caught: LockTimeoutError | null = null;
    try {
      await acquireWithTTL(target, {
        ttlSec: 300,
        isAlive: (pid) => pid !== 12345,
        timeoutMs: 200,
        retryDelayMs: 30,
        // no auditDir → no log file written
      });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    expect(caught).not.toBeNull();
    // Confirm no audit log file appeared in the silent-recovery audit dir.
    const { stat } = await import("node:fs/promises");
    let auditExisted = false;
    try {
      await stat(join(auditDir, "lock-recovery.log"));
      auditExisted = true;
    } catch {
      auditExisted = false;
    }
    expect(auditExisted).toBe(false);
    await child.exited;
  });

  test("default isAlive uses process.kill(pid, 0) for a nonexistent PID and audits the orphan", async () => {
    const target = join(dir, "default-dead-pid");
    const lockPath = `${target}.lock`;
    const auditDir = join(dir, "logs-default-dead-pid");

    const child = Bun.spawn([
      "bun",
      "-e",
      `
        const lock = await import("${process.cwd()}/src/abstractions/lock.ts");
        const h = await lock.acquire("${target}");
        process.stdout.write("ready\\n");
        await new Promise(r => setTimeout(r, 1500));
        await h.release();
      `,
    ], { stdout: "pipe" });
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      reader = child.stdout?.getReader() ?? null;
      const decoder = new TextDecoder();
      let readyText = "";
      while (!readyText.includes("ready\n")) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("child exited before signaling ready");
        }
        readyText += decoder.decode(chunk.value, { stream: true });
      }
      expect(readyText).toContain("ready\n");
      // 99999999 is intentionally far above the local process table; if a
      // platform does somehow allocate it, the test will need a different
      // deterministic nonexistent-PID source.
      await writeFile(lockPath, "99999999\n");
      const oldEpoch = Date.now() / 1000 - 600;
      const { utimes } = await import("node:fs/promises");
      await utimes(lockPath, oldEpoch, oldEpoch);

      let caught: LockTimeoutError | null = null;
      try {
        await acquireWithTTL(target, {
          ttlSec: 300,
          auditDir,
          timeoutMs: 200,
          retryDelayMs: 30,
        });
      } catch (e) {
        if (e instanceof LockTimeoutError) caught = e;
      }
      expect(caught).not.toBeNull();
      const auditLog = join(auditDir, "lock-recovery.log");
      const text = await readFile(auditLog, "utf8");
      expect(text).toContain(lockPath);
      expect(text).toContain("prev_pid=99999999");
      expect(text).toContain("reason=ttl-orphan");
    } finally {
      await reader?.cancel().catch(() => {});
      await child.exited;
    }
  });

  test("default isAlive uses process.kill(pid, 0) — own PID is alive", async () => {
    const target = join(dir, "self-alive");
    const lockPath = `${target}.lock`;
    // Stamp a fake "old" lock with our own PID. Because OUR PID is
    // alive, recovery should NOT happen even though age > TTL. But
    // since we hold no actual flock, we'd succeed via the immediate
    // probe path. Instead, hold the flock externally + assert no force
    // recovery against our own PID.
    await writeFile(lockPath, `${process.pid}\n`);
    const oldEpoch = Date.now() / 1000 - 600;
    const { utimes } = await import("node:fs/promises");
    await utimes(lockPath, oldEpoch, oldEpoch);

    // Hold flock externally.
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
      await acquireWithTTL(target, { ttlSec: 0, timeoutMs: 200, retryDelayMs: 30 });
    } catch (e) {
      if (e instanceof LockTimeoutError) caught = e;
    }
    // process.pid is alive — should not force-release; wait + timeout.
    expect(caught).not.toBeNull();
    await child.exited;
  });
});
