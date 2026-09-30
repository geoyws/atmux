// Map-backed fake of the ADR-305 `SocketDirFs` seam (src/core/socket-dir.ts).
//
// Drives what one uid cannot produce on a real disk: another uid's
// directory or socket, EACCES, a racing mkdir, a directory that vanishes.
// Paths are keys; a "descriptor" is the walked path plus a counter, so a
// test can prove the walk closes every handle it opened.
//
// `/` (root 0755) and `/tmp` (root 1777, sticky) exist unless the test
// supplies its own nodes for them — the normal Linux base the whole-chain
// rule walks through.

import { join } from "node:path";
import type { DirHandle, SocketDirFs, SocketNodeStat } from "../../src/core/socket-dir.ts";

export type FakeKind = "dir" | "socket" | "file" | "symlink";

export interface FakeNode {
  kind: FakeKind;
  uid: number;
  mode: number;
  /** Symlink target (kind "symlink"). */
  target?: string;
}

export const dir = (uid: number, mode = 0o700): FakeNode => ({ kind: "dir", uid, mode });
export const sock = (uid: number, mode = 0o660): FakeNode => ({ kind: "socket", uid, mode });
export const file = (uid: number, mode = 0o600): FakeNode => ({ kind: "file", uid, mode });
export const link = (target: string, uid = 0): FakeNode => ({
  kind: "symlink",
  uid,
  mode: 0o777,
  target,
});

export interface FakeSocketFsOpts {
  /** uid `mkdirAt` creates as (default 1000). */
  creatorUid?: number;
  /** path → errno code thrown by `openDirAt`. */
  openThrows?: Record<string, string>;
  /** path → errno code thrown by `lstat` / `lstatAt`. */
  lstatThrows?: Record<string, string>;
  /** path → errno code thrown by `mkdirAt`. */
  mkdirThrows?: Record<string, string>;
  /** `mkdirAt(path)` reports EEXIST and plants this node instead. */
  raceOn?: Record<string, FakeNode>;
  /** path → errno code `openDirAt` throws once `mkdirAt` created it
   *  (ENOENT = the directory vanished right after creation). */
  afterCreateOpenThrows?: Record<string, string>;
  /** `openRoot` throws this code. */
  rootThrows?: string;
}

export interface FakeSocketFs extends SocketDirFs {
  readonly nodes: Map<string, FakeNode>;
  /** `open <path>` / `mkdir <path>` / `mkdirp <path> <mode>` / `lstat <path>`. */
  readonly calls: string[];
  /** Handles opened and not yet closed. */
  openHandles(): number;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function statOf(n: FakeNode): SocketNodeStat {
  return {
    uid: n.uid,
    mode: n.mode,
    isDirectory: () => n.kind === "dir",
    isSymbolicLink: () => n.kind === "symlink",
    isSocket: () => n.kind === "socket",
  };
}

export function fakeSocketFs(
  nodes: Record<string, FakeNode> = {},
  opts: FakeSocketFsOpts = {},
): FakeSocketFs {
  const map = new Map<string, FakeNode>([
    ["/", dir(0, 0o755)],
    ["/tmp", dir(0, 0o1777)],
    ...Object.entries(nodes),
  ]);
  const calls: string[] = [];
  const open = new Set<number>();
  const created = new Set<string>();
  let nextFd = 3;
  const handle = (path: string): DirHandle => {
    const fd = nextFd++;
    open.add(fd);
    return { path, fd };
  };
  const lstatPath = (path: string): SocketNodeStat | null => {
    calls.push(`lstat ${path}`);
    const code = opts.lstatThrows?.[path];
    if (code !== undefined) throw errno(code);
    const n = map.get(path);
    return n === undefined ? null : statOf(n);
  };
  return {
    nodes: map,
    calls,
    openHandles: () => open.size,
    lstat: lstatPath,
    mkdirp(path, mode) {
      calls.push(`mkdirp ${path} ${mode.toString(8)}`);
    },
    openRoot() {
      calls.push("open /");
      if (opts.rootThrows !== undefined) throw errno(opts.rootThrows);
      return handle("/");
    },
    openDirAt(parent, name) {
      const path = join(parent.path, name);
      calls.push(`open ${path}`);
      const code = opts.openThrows?.[path];
      if (code !== undefined) throw errno(code);
      const late = opts.afterCreateOpenThrows?.[path];
      if (late !== undefined && created.has(path)) throw errno(late);
      const n = map.get(path);
      if (n === undefined) throw errno("ENOENT");
      // Linux: open(O_DIRECTORY|O_NOFOLLOW) on a symlink is ENOTDIR.
      if (n.kind !== "dir") throw errno("ENOTDIR");
      return handle(path);
    },
    fstat(h) {
      return statOf(map.get(h.path) as FakeNode);
    },
    lstatAt(parent, name) {
      return lstatPath(join(parent.path, name));
    },
    readlinkAt(parent, name) {
      return (map.get(join(parent.path, name)) as FakeNode).target as string;
    },
    mkdirAt(parent, name) {
      const path = join(parent.path, name);
      calls.push(`mkdir ${path}`);
      const code = opts.mkdirThrows?.[path];
      if (code !== undefined) throw errno(code);
      const race = opts.raceOn?.[path];
      if (race !== undefined) {
        map.set(path, race);
        return false;
      }
      if (map.has(path)) return false;
      map.set(path, dir(opts.creatorUid ?? 1000, 0o700));
      created.add(path);
      return true;
    },
    close(h) {
      open.delete(h.fd);
    },
  };
}
