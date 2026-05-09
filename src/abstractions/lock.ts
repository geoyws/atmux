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
import {
  appendFile as _appendFile,
  open as _open,
  stat as _stat,
  writeFile as _writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** ADR-057 §D3a — lock-TTL with crashed-PID auto-recovery. */
export interface AcquireWithTtlOpts extends AcquireOpts {
  /** Owner PID written into the lock file. Defaults to process.pid. */
  ownerPid?: number;
  /** When the lock has been held longer than this (mtime-derived) AND
   *  the recorded PID is dead, force-release. Default 300s (5min). */
  ttlSec?: number;
  /** Audit-log directory; recovery events write to
   *  `<auditDir>/lock-recovery.log`. When undefined, recovery is silent.
   *  Verb callers typically pass `<atmuxDir>/logs`. */
  auditDir?: string;
  /** Liveness check override (test injection). Defaults to a
   *  `process.kill(pid, 0)` POSIX-style probe — returns true if the
   *  process exists. */
  isAlive?: (pid: number) => boolean;
  /** Clock override (test injection); defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 50;
/** ADR-057 §D3a TTL default — 5min. Configurable per-acquire. */
const DEFAULT_TTL_SEC = 300;

/**
 * Acquire an exclusive flock on `<path>.lock`. Polls every `retryDelayMs`
 * via `flock(LOCK_EX | LOCK_NB)` until success or budget exhaustion.
 *
 * ADR-057 §D3b: writes the owner PID to the lock file on successful
 * acquire (overwriting any stale content). Concurrent readers can use
 * `readLockOwnerPid` to inspect; callers who need crashed-owner recovery
 * use `acquireWithTTL` instead.
 */
export async function acquire(path: string, opts?: AcquireOpts): Promise<LockHandle> {
  return await _acquireInternal(path, opts);
}

/**
 * ADR-057 §D3a: like `acquire`, but if the lock can't be obtained AND
 * the recorded PID is dead AND the lock is older than `ttlSec`, the
 * orphan lock is force-released + a recovery line is appended to
 * `<auditDir>/lock-recovery.log` (when `auditDir` is set), then the
 * acquire retries.
 *
 * Live owner → standard wait-with-retry semantics (no force-release;
 * real contention).
 *
 * Liveness check is `process.kill(pid, 0)` by default — POSIX `kill -0`
 * tests for process existence without delivering a signal. Throws ESRCH
 * when the process is gone (we treat that as "dead"); permission errors
 * (EPERM) on a foreign PID are treated as "alive" defensively.
 */
export async function acquireWithTTL(path: string, opts?: AcquireWithTtlOpts): Promise<LockHandle> {
  const ttlSec = opts?.ttlSec ?? DEFAULT_TTL_SEC;
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  const nowFn = opts?.now ?? Date.now;
  const ownerPid = opts?.ownerPid ?? process.pid;

  const lockPath = `${path}.lock`;
  await ensureDir(dirname(lockPath));

  // Try to acquire; if contended, inspect for orphan + force-release.
  // The non-blocking probe is a single attempt — if contention persists
  // even after the orphan check, we fall through to the standard
  // wait-with-retry path via `_acquireInternal`.
  const lib = loadFlock();
  const probe = await _open(lockPath, "a");
  const probeFd = probe.fd;
  const initialRc = lib.flock(probeFd, LOCK_EX | LOCK_NB);
  if (initialRc === 0) {
    // Got it on first try — write PID + return handle (manual since we
    // already hold the FD).
    await _writePid(lockPath, ownerPid);
    return _makeHandle(probe, lib, lockPath);
  }
  // Contention. Read existing PID + check liveness — emit an audit
  // line when the recorded PID is dead AND the lock age is past TTL.
  //
  // SAFETY NOTE: we DO NOT unlink the orphan lock file here. The
  // kernel-level flock is bound to the file's inode + the holding
  // process's FD — when the holder exits, the kernel releases the
  // flock automatically; the next acquire then succeeds via the
  // wait-with-retry path. Unlinking the lock file would create a NEW
  // inode for the next acquire, breaking flock mutual exclusion if
  // the original holder is still alive (or its FD-table entry hasn't
  // been reaped yet). Audit-only is the safe contract under POSIX
  // advisory locks; R57-T6 heartbeat substrate later enables a
  // safer "fence + reacquire" recovery path when needed.
  await closeQuiet(probe);
  try {
    const recordedPid = await _readLockOwnerPid(lockPath);
    if (recordedPid !== null && !isAlive(recordedPid)) {
      const stat = await _stat(lockPath).catch(() => null);
      const ageSec = stat === null ? 0 : (nowFn() - stat.mtimeMs) / 1000;
      if (ageSec > ttlSec && opts?.auditDir !== undefined) {
        await _auditRecovery(opts.auditDir, lockPath, recordedPid, ageSec);
      }
    }
  } catch {
    // Audit failures shouldn't mask the acquire path.
  }

  // Finish via the normal acquire path (writes PID on success). If the
  // dead-but-orphan-flock scenario is real, the kernel will have
  // released the flock by now; if the holder was alive (and we
  // misread the PID), wait-with-retry handles it.
  return await _acquireInternal(path, opts);
}

/**
 * Read the owner PID from a lock file. Returns null when the file is
 * absent, empty, or the content isn't a parseable positive integer.
 */
export async function readLockOwnerPid(lockPath: string): Promise<number | null> {
  return _readLockOwnerPid(lockPath);
}

// ---------- Internal acquire (PID-bearing) ----------

async function _acquireInternal(path: string, opts?: AcquireOpts): Promise<LockHandle> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const ownerPid = (opts as AcquireWithTtlOpts | undefined)?.ownerPid ?? process.pid;
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
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      await closeQuiet(handle);
      throw new LockTimeoutError({ path: lockPath, timeoutMs });
    }
    await sleep(retryDelayMs);
  }

  // ADR-057 §D3b: stamp owner PID on successful acquire. Best-effort —
  // PID write failure shouldn't fail the acquire (the lock is held,
  // and the audit trail is a "would be nice" not load-bearing).
  await _writePid(lockPath, ownerPid).catch(() => {});

  return _makeHandle(handle, lib, lockPath);
}

function _makeHandle(
  handle: { fd: number; close: () => Promise<void> },
  lib: FlockSymbols,
  lockPath: string,
): LockHandle {
  let released = false;
  return {
    lockPath,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        lib.flock(handle.fd, LOCK_UN);
      } catch {
        /* expected: best-effort release; FD close also drops the lock */
      }
      await closeQuiet(handle);
    },
  };
}

async function _writePid(lockPath: string, pid: number): Promise<void> {
  await _writeFile(lockPath, `${pid}\n`, { mode: 0o644 });
}

async function _readLockOwnerPid(lockPath: string): Promise<number | null> {
  try {
    const handle = await _open(lockPath, "r");
    try {
      const buf = Buffer.alloc(32);
      const { bytesRead } = await handle.read(buf, 0, 32, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8").trim();
      if (text.length === 0) return null;
      const n = Number.parseInt(text, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

async function _auditRecovery(
  auditDir: string,
  lockPath: string,
  prevPid: number,
  ageSec: number,
): Promise<void> {
  await ensureDir(auditDir);
  const logPath = join(auditDir, "lock-recovery.log");
  const line = `${Math.floor(Date.now() / 1000)} ${lockPath} prev_pid=${prevPid} age_sec=${Math.floor(ageSec)} reason=ttl-orphan\n`;
  await _appendFile(logPath, line, { mode: 0o644 }).catch(() => {});
}

/** POSIX `kill -0`: probes process existence. ESRCH → dead. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but we lack permission to signal —
    // treat as alive (defensive). Other errors also default to alive.
    return true;
  }
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
