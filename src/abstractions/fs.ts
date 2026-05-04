// ADR-003: filesystem primitives wrapped with typed errors.
//
// Thin typed layer over `node:fs/promises`. Every IO failure throws
// `FsError` (per ADR-006) with `op` + `path` for triage. The atomic-write
// helper (`atomicWrite`) implements the bash mktemp + rename pattern that
// `lib/common.sh::atmux::jq_update` relies on; `json.ts` (ADR-005) builds
// `updateJson` on top.

import {
  mkdir as _mkdir,
  open as _open,
  readFile as _readFile,
  rename as _rename,
  rm as _rm,
  stat as _stat,
  writeFile as _writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { FsError } from "../errors.ts";

// ---------- Existence + stat ----------

export interface PathStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

/** True if a regular file or directory exists at `path`. */
export async function exists(path: string): Promise<boolean> {
  try {
    await _stat(path);
    return true;
  } catch (e) {
    if (isEnoent(e)) return false; // expected: missing-file = non-existence
    throw new FsError({ path, op: "stat", cause: e });
  }
}

/** Light stat shim; throws FsError on real failures, returns null on ENOENT. */
export async function statOrNull(path: string): Promise<PathStat | null> {
  try {
    const s = await _stat(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  } catch (e) {
    if (isEnoent(e)) return null; // expected: caller wants "is it there?"
    throw new FsError({ path, op: "stat", cause: e });
  }
}

// ---------- Create / remove ----------

/** mkdir -p, idempotent. Throws FsError on a real failure. */
export async function ensureDir(path: string): Promise<void> {
  try {
    await _mkdir(path, { recursive: true });
  } catch (e) {
    throw new FsError({ path, op: "mkdir", cause: e });
  }
}

/** rm -f (file). Returns silently if missing; throws otherwise. */
export async function removeFile(path: string): Promise<void> {
  try {
    await _rm(path, { force: true });
  } catch (e) {
    throw new FsError({ path, op: "unlink", cause: e });
  }
}

/** rm -rf (dir or file). Throws FsError on a real failure. */
export async function removeRecursive(path: string): Promise<void> {
  try {
    await _rm(path, { recursive: true, force: true });
  } catch (e) {
    throw new FsError({ path, op: "unlink", cause: e });
  }
}

// ---------- Read / write ----------

/** Read a file as UTF-8 text. Throws FsError on miss + on real failure. */
export async function readText(path: string): Promise<string> {
  try {
    return await _readFile(path, "utf8");
  } catch (e) {
    throw new FsError({ path, op: "read", cause: e });
  }
}

/** Read a file as UTF-8 text; return null on ENOENT (expected absence). */
export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await _readFile(path, "utf8");
  } catch (e) {
    if (isEnoent(e)) return null; // expected: caller treats absence as no-op
    throw new FsError({ path, op: "read", cause: e });
  }
}

/** writeFile that ensures the parent dir exists first. */
export async function writeText(path: string, content: string, mode = 0o644): Promise<void> {
  await ensureDir(dirname(path));
  try {
    await _writeFile(path, content, { encoding: "utf8", mode });
  } catch (e) {
    throw new FsError({ path, op: "write", cause: e });
  }
}

// ---------- Atomic write (mktemp + rename) ----------

/**
 * Atomic write: write to `<path>.tmp.<pid>.<rand>` (with optional fsync),
 * rename to `path`. Mirrors bash `lib/common.sh::atmux::jq_update`'s
 * mktemp+mv pattern. Caller wraps in `lock.withLock(path, ...)` if
 * concurrency matters (per ADR-005). Cleans up the temp file on either
 * write or rename failure (best-effort).
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  opts?: { mode?: number; fsync?: boolean },
): Promise<void> {
  const mode = opts?.mode ?? 0o644;
  const doFsync = opts?.fsync ?? true;
  await ensureDir(dirname(path));
  const tmp = tmpPath(path);
  try {
    await writeAndSync(tmp, content, mode, doFsync);
    await _rename(tmp, path);
  } catch (e) {
    // Best-effort cleanup of tmp before surfacing the original cause.
    // op is "write" because the caller's intent was to write `path`;
    // the rename-vs-write distinction is preserved in `cause`.
    await removeBestEffort(tmp);
    throw new FsError({ path, op: "write", cause: e });
  }
}

/** Build the temp path used by `atomicWrite`. Exported for tests. */
export function tmpPath(path: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${path}.tmp.${process.pid}.${rand}`;
}

// ---------- Internal helpers ----------

function isEnoent(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}

/** Open + writeFile + (optionally) fsync + close. Errors propagate. */
async function writeAndSync(
  path: string,
  content: string | Uint8Array,
  mode: number,
  doFsync: boolean,
): Promise<void> {
  const handle = await _open(path, "w", mode);
  try {
    await handle.writeFile(content);
    if (doFsync) await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best-effort temp-file cleanup. Swallows because the caller is already
 *  in an error path; surfacing a secondary error would mask the first. */
async function removeBestEffort(path: string): Promise<void> {
  try {
    await _rm(path, { force: true });
  } catch {
    // expected: cleanup is best-effort; the caller is already handling a failure
  }
}
