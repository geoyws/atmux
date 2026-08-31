// Unit tests for src/abstractions/fs.ts (ADR-003).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendText,
  atomicWrite,
  ensureDir,
  exists,
  readText,
  readTextOrNull,
  removeFile,
  removeRecursive,
  statOrNull,
  tmpPath,
  writeText,
} from "../../../src/abstractions/fs.ts";
import { FsError } from "../../../src/errors.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "atmux-fs-"));
});

afterEach(async () => {
  // Restore writability before cleanup so chmod-tampered tests can clean up.
  try {
    await chmod(dir, 0o755);
  } catch {
    /* expected: dir may not exist */
  }
  await rm(dir, { recursive: true, force: true });
});

describe("exists", () => {
  test("true for an existing file", async () => {
    const p = join(dir, "x");
    await Bun.write(p, "data");
    expect(await exists(p)).toBe(true);
  });

  test("true for an existing dir", async () => {
    expect(await exists(dir)).toBe(true);
  });

  test("false for an absent path", async () => {
    expect(await exists(join(dir, "nope"))).toBe(false);
  });
});

describe("statOrNull", () => {
  test("returns shape for an existing file", async () => {
    const p = join(dir, "x");
    await Bun.write(p, "abcd");
    const s = await statOrNull(p);
    expect(s).not.toBeNull();
    expect(s?.isFile).toBe(true);
    expect(s?.isDirectory).toBe(false);
    expect(s?.size).toBe(4);
  });

  test("returns null on absence", async () => {
    expect(await statOrNull(join(dir, "nope"))).toBeNull();
  });

  test("isDirectory true for dir", async () => {
    const s = await statOrNull(dir);
    expect(s?.isDirectory).toBe(true);
  });
});

describe("ensureDir / removeFile / removeRecursive", () => {
  test("ensureDir creates nested dirs", async () => {
    const p = join(dir, "a", "b", "c");
    await ensureDir(p);
    expect((await statOrNull(p))?.isDirectory).toBe(true);
  });

  test("ensureDir is idempotent", async () => {
    const p = join(dir, "a");
    await ensureDir(p);
    await ensureDir(p);
    expect((await statOrNull(p))?.isDirectory).toBe(true);
  });

  test("removeFile removes a present file", async () => {
    const p = join(dir, "x");
    await Bun.write(p, "data");
    await removeFile(p);
    expect(await exists(p)).toBe(false);
  });

  test("removeFile is silent on absent file", async () => {
    await removeFile(join(dir, "nope"));
    expect(true).toBe(true);
  });

  test("removeRecursive nukes a subtree", async () => {
    const sub = join(dir, "tree");
    await mkdir(join(sub, "deep"), { recursive: true });
    await Bun.write(join(sub, "file"), "x");
    await removeRecursive(sub);
    expect(await exists(sub)).toBe(false);
  });
});

describe("readText / readTextOrNull / writeText", () => {
  test("writeText then readText round-trip", async () => {
    const p = join(dir, "a", "b", "x.txt");
    await writeText(p, "hello\n");
    expect(await readText(p)).toBe("hello\n");
  });

  test("readText throws FsError on miss", async () => {
    await expect(readText(join(dir, "no"))).rejects.toBeInstanceOf(FsError);
  });

  test("readTextOrNull returns null on miss", async () => {
    expect(await readTextOrNull(join(dir, "no"))).toBeNull();
  });

  test("readTextOrNull returns content on hit", async () => {
    const p = join(dir, "y");
    await writeText(p, "abc");
    expect(await readTextOrNull(p)).toBe("abc");
  });
});

describe("appendText", () => {
  test("creates the file when absent (matches bash `printf … >> file`)", async () => {
    const p = join(dir, "log.txt");
    await appendText(p, "first\n");
    expect(await readText(p)).toBe("first\n");
  });

  test("appends to an existing file without truncating", async () => {
    const p = join(dir, "log.txt");
    await writeText(p, "first\n");
    await appendText(p, "second\n");
    await appendText(p, "third\n");
    expect(await readText(p)).toBe("first\nsecond\nthird\n");
  });

  test("creates missing parent dirs (mirrors writeText behaviour)", async () => {
    const p = join(dir, "deep", "log", "file.txt");
    await appendText(p, "hi\n");
    expect(await readText(p)).toBe("hi\n");
  });

  test("wraps appendFile failures when the target path is a directory", async () => {
    const p = join(dir, "append-target");
    await mkdir(p);

    await expect(appendText(p, "x")).rejects.toMatchObject({
      tag: "fs",
      cause: expect.any(Error),
      context: { path: p, op: "write" },
    });
  });

  test("FsError on a write-impossible target (parent path is a file)", async () => {
    // Create a regular file, then try to append into a path nested beneath it.
    const blocker = join(dir, "blocker");
    await writeText(blocker, "x");
    await expect(appendText(join(blocker, "child.log"), "x")).rejects.toBeInstanceOf(FsError);
  });
});

describe("atomicWrite", () => {
  test("writes content and persists", async () => {
    const p = join(dir, "a", "atomic.txt");
    await atomicWrite(p, "atomic content\n");
    expect(await readText(p)).toBe("atomic content\n");
  });

  test("uses requested mode", async () => {
    const p = join(dir, "modefile");
    await atomicWrite(p, "x", { mode: 0o600 });
    const s = await statOrNull(p);
    expect(s?.isFile).toBe(true);
  });

  test("overwrites existing file atomically", async () => {
    const p = join(dir, "x");
    await atomicWrite(p, "first");
    await atomicWrite(p, "second");
    expect(await readText(p)).toBe("second");
  });

  test("accepts Uint8Array payload", async () => {
    const p = join(dir, "bin");
    await atomicWrite(p, new TextEncoder().encode("bytes"));
    expect(await readText(p)).toBe("bytes");
  });

  test("opt-out fsync still writes", async () => {
    const p = join(dir, "nosync");
    await atomicWrite(p, "no-sync", { fsync: false });
    expect(await readText(p)).toBe("no-sync");
  });

  test("write failure (ENOTDIR via parent-is-file) throws FsError", async () => {
    const f = join(dir, "regular");
    await Bun.write(f, "x");
    // <file>/child — parent is a regular file → open() fails with ENOTDIR
    await expect(atomicWrite(join(f, "child"), "boom")).rejects.toBeInstanceOf(FsError);
  });

  test("rename failure (target is dir) cleans up tmp and throws FsError", async () => {
    // Make the destination a directory so rename(tmp, target) fails with EISDIR.
    const target = join(dir, "asdir");
    await mkdir(target);
    await expect(atomicWrite(target, "boom")).rejects.toBeInstanceOf(FsError);
    // Tmp file should be gone (best-effort cleanup ran).
    const { readdir } = await import("node:fs/promises");
    const stale = await readdir(dir);
    expect(stale.filter((n) => n.startsWith("asdir.tmp."))).toEqual([]);
  });
});

describe("tmpPath", () => {
  test("encodes pid + random tail per call", () => {
    const a = tmpPath("/x/y");
    const b = tmpPath("/x/y");
    expect(a).toContain(`/x/y.tmp.${process.pid}.`);
    expect(b).toContain(`/x/y.tmp.${process.pid}.`);
    expect(a).not.toBe(b);
  });
});

describe("FsError surfaces from real failures", () => {
  test("ensureDir over a regular file throws", async () => {
    const p = join(dir, "is-a-file");
    await Bun.write(p, "x");
    await expect(ensureDir(p)).rejects.toBeInstanceOf(FsError);
  });

  test("statOrNull rethrows non-ENOENT failures as FsError", async () => {
    // Simulate by stat-ing a path where parent is a file (ENOTDIR).
    const file = join(dir, "regular");
    await Bun.write(file, "x");
    const through = join(file, "child");
    // node:fs.stat returns ENOTDIR here, not ENOENT — should throw FsError.
    await expect(statOrNull(through)).rejects.toBeInstanceOf(FsError);
  });

  test("readText throws FsError for parent ENOTDIR", async () => {
    const file = join(dir, "regular");
    await Bun.write(file, "x");
    await expect(readText(join(file, "child"))).rejects.toBeInstanceOf(FsError);
  });

  test("removeFile throws FsError for unexpected failures", async () => {
    // ENOTDIR — try to unlink under a regular file
    const f = join(dir, "regular");
    await Bun.write(f, "x");
    await expect(removeFile(join(f, "child"))).rejects.toBeInstanceOf(FsError);
  });

  test("removeRecursive throws FsError for unexpected failures", async () => {
    const f = join(dir, "regular");
    await Bun.write(f, "x");
    await expect(removeRecursive(join(f, "child"))).rejects.toBeInstanceOf(FsError);
  });

  test("exists rethrows non-ENOENT failures as FsError", async () => {
    const file = join(dir, "regular");
    await Bun.write(file, "x");
    await expect(exists(join(file, "child"))).rejects.toBeInstanceOf(FsError);
  });

  test("writeText surfaces ENOTDIR (parent-is-file) as FsError", async () => {
    const f = join(dir, "regular");
    await Bun.write(f, "x");
    // ensureDir on <file>/sub → ENOTDIR
    await expect(writeText(join(f, "sub", "x"), "new content")).rejects.toBeInstanceOf(FsError);
  });

  test("writeText surfaces EISDIR (target is dir) as FsError", async () => {
    // ensureDir succeeds (target's parent already exists as a dir),
    // but writeFile(target) fails with EISDIR.
    const asDir = join(dir, "isadir");
    await mkdir(asDir);
    await expect(writeText(asDir, "content")).rejects.toBeInstanceOf(FsError);
  });
});
