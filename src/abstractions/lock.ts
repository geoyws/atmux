// ADR-005: file-lock primitive via flock(2).
//
// Hand-rolled wrapper over libc's `flock(2)` via `bun:ffi`. Matches the
// bash side's `lib/common.sh::atmux::with_lock` semantics — exclusive
// lock on a sidecar `<path>.lock` file, auto-released on FD close (which
// includes process death). Concurrent bash + TS workers during Phase 4
// cutover lock against each other correctly because both speak flock(2).
//
// `proper-lockfile` was rejected (ADR-005 §"Alternatives considered A")
// — different lock semantics from bash, breaks cross-language behaviour.

import { dlopen, FFIType, suffix } from "bun:ffi";
import { open as _open } from "node:fs/promises";
import { dirname } from "node:path";
import { LockError, LockTimeoutError } from "../errors.ts";
import { ensureDir } from "./fs.ts";

// ---------- libc flock(2) binding ----------

// LOCK_EX = 2 (exclusive), LOCK_NB = 4 (non-blocking), LOCK_UN = 8 (release).
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** Candidate libc paths, tried in order. First success wins. Exported
 *  so tests can verify the fallback walk by passing curated lists. */
export const LIBC_PATHS: ReadonlyArray<string> = [
  // Linux: glibc default name
  "libc.so.6",
  // macOS: libc lives inside libSystem
  "libSystem.B.dylib",
  // Generic fallback (Bun's `suffix` is `so` / `dylib`)
  `libc.${suffix}`,
];

export interface FlockSymbols {
  flock: (fd: number, op: number) => number;
}

let cached: FlockSymbols | null = null;

/** Walk `paths` and return the first that successfully loads `flock(2)`.
 *  Throws `LockError` once all candidates fail. Exported for unit tests. */
export function tryLoadFlock(paths: ReadonlyArray<string>): FlockSymbols {
  let lastErr: unknown = null;
  for (const path of paths) {
    try {
      const lib = dlopen(path, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      return {
        flock: (fd: number, op: number): number =>
          (lib.symbols.flock as (a: number, b: number) => number)(fd, op),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new LockError({
    path: "<libc>",
    cause: new Error(`could not load libc for flock(2): ${String(lastErr)}`),
  });
}

function loadFlock(): FlockSymbols {
  if (!cached) cached = tryLoadFlock(LIBC_PATHS);
  return cached;
}

// ---------- Public API ----------

export interface LockHandle {
  /** Path of the sidecar lock file (`<original>.lock`). */
  readonly lockPath: string;
  /** Idempotent. Releases the flock, closes the FD, leaves the lockfile
   *  on disk (cheap; matches bash). */
  release(): Promise<void>;
}

export interface AcquireOpts {
  /** Total budget before LockTimeoutError. Default 5_000ms. */
  timeoutMs?: number;
  /** Sleep between retries while waiting. Default 50ms. */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 50;

/**
 * Acquire an exclusive flock on `<path>.lock`. Polls every `retryDelayMs`
 * via `flock(LOCK_EX | LOCK_NB)` until success or budget exhaustion.
 */
export async function acquire(path: string, opts?: AcquireOpts): Promise<LockHandle> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const lockPath = `${path}.lock`;
  await ensureDir(dirname(lockPath));

  const handle = await _open(lockPath, "a");
  const fd = handle.fd;
  const lib = loadFlock();

  const start = Date.now();
  let acquired = false;
  while (!acquired) {
    const rc = lib.flock(fd, LOCK_EX | LOCK_NB);
    if (rc === 0) {
      acquired = true;
      break;
    }
    // rc === -1 → another process holds the lock (typically EWOULDBLOCK).
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      await closeQuiet(handle);
      throw new LockTimeoutError({ path: lockPath, timeoutMs });
    }
    await sleep(retryDelayMs);
  }

  let released = false;
  return {
    lockPath,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        lib.flock(fd, LOCK_UN);
      } catch {
        /* expected: best-effort release; FD close also drops the lock */
      }
      await closeQuiet(handle);
    },
  };
}

/**
 * Convenience wrapper. Acquires a lock, runs `fn`, releases the lock.
 * `fn`'s return / throw flows through unchanged. The lock is released
 * even if `fn` throws.
 */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  opts?: AcquireOpts,
): Promise<T> {
  const handle = await acquire(path, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

// ---------- Internals ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeQuiet(handle: { close: () => Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    /* expected: best-effort cleanup */
  }
}
