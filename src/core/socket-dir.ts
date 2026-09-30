// ADR-305: per-user, private tmux socket directories.
//
// Every `-S <path>` socket atmux creates or connects to lives in a
// directory that only its owner can enter. Measured on @@hax on
// 2026-09-30: `/tmp/atmux-<team>/` directories were mode 0777 with 0777
// sockets, and the `nobody` user could run `tmux -S <sock> has-session`
// against root's live cages — any local user could drive a root shell.
// A second local user running its own atmux would also have shared
// `/tmp/atmux-<team>/` with root.
//
// Path scheme (ADR-305 §D1):
//   per-user root   /tmp/atmux-<uid>                 (0700, owned by uid)
//   team cage       /tmp/atmux-<uid>/<team>/sock     (dir 0700)
//   group server    /tmp/atmux-<uid>/grp-<group>/sock (dir 0700)
//   tmuxTmpdir team <tmuxTmpdir>/tmux-<uid>/default   (leaf dir 0700)
//   cockpit         tmux's own $TMUX_TMPDIR/tmux-<uid>/ (tmux creates it)
//
// The per-user root is one `/tmp` entry, not `/tmp/atmux-<uid>-<team>`:
// a name with a second hyphen matches groom's zombie-fixture sweep
// pattern (`^atmux-…-…$`), which kills the tmux servers it finds.
//
// Rules (ADR-305 §D2): a directory atmux creates is created 0700 (and
// chmod'ed to 0700 right after creation, so a stray umask cannot leave it
// wider or narrower). An EXISTING directory is never chmod'ed: when it is
// a symlink, not a directory, owned by another uid, or carries any group
// or world bit, atmux refuses with the exact fix. A socket node owned by
// another uid is refused too. Nothing here ever widens a mode.
//
// Legacy compatibility (ADR-305 §D3): a cage or group server that is
// still on the pre-ADR `/tmp/atmux-<team>/sock` path is used only while
// that socket is ours AND its directory passes the same private check.
// `start` moves a dead one to the per-user path; a live one in a shared
// directory is refused with the chmod that adopts it.

import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { ConfigError } from "../errors.ts";

/** Base directory for every atmux-created `-S` socket tree. Literal
 *  `/tmp` (not `os.tmpdir()`): cron, launchd and interactive shells must
 *  all resolve the same path, and macOS `$TMPDIR` differs per session. */
export const SOCKET_BASE_DIR = "/tmp";

/** The only mode atmux ever gives a socket directory it creates. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Stable capability marker (ADR-305 §D5). Printed as its own line by
 * `atmux version --features` and carried in the green `socket-dir`
 * doctor row, so a bootstrap can refuse an atmux build that predates
 * per-user private socket directories:
 *
 *   atmux version --features | grep -qx 'socket-dirs=per-user-0700'
 *
 * Never reword it; a successor scheme gets a new marker.
 */
export const SOCKET_DIR_FEATURE = "socket-dirs=per-user-0700";

/** Group + world permission bits. Any of them set ⇒ not private. */
const GROUP_WORLD_BITS = 0o077;

/** The subset of `fs.Stats` the policy reads. */
export interface SocketNodeStat {
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
}

/** Filesystem seam. Production uses {@link realSocketDirFs}; unit tests
 *  inject a fake to drive foreign-owner / symlink / EACCES branches that
 *  a single-uid test process cannot produce on a real filesystem. */
export interface SocketDirFs {
  /** `lstat` (never follows the final symlink). `null` when the path does
   *  not exist (ENOENT / ENOTDIR). Any other failure throws. */
  lstat(path: string): SocketNodeStat | null;
  /** Create ONE directory level with `mode`. `true` when created, `false`
   *  when something already exists at the path (EEXIST). */
  mkdir(path: string, mode: number): boolean;
  /** `mkdir -p` with `mode` applied to every directory it creates. */
  mkdirp(path: string, mode: number): void;
  chmod(path: string, mode: number): void;
}

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

export const realSocketDirFs: SocketDirFs = {
  lstat(path) {
    try {
      return lstatSync(path);
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw e;
    }
  },
  mkdir(path, mode) {
    try {
      mkdirSync(path, { mode });
      return true;
    } catch (e) {
      if (errCode(e) === "EEXIST") return false;
      throw e;
    }
  },
  mkdirp(path, mode) {
    mkdirSync(path, { recursive: true, mode });
  },
  chmod(path, mode) {
    chmodSync(path, mode);
  },
};

/** Options shared by every resolver / guard in this module. */
export interface SocketDirOpts {
  /** Override `process.getuid()`. `null` = no POSIX uid (non-POSIX
   *  platform): paths fall back to the legacy shape and checks are off. */
  uid?: number | null;
  fs?: SocketDirFs;
}

/** The effective uid, or `null` where the platform has none. */
export function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function uidOf(opts: SocketDirOpts): number | null {
  return opts.uid === undefined ? currentUid() : opts.uid;
}

// ---------- Paths ----------

/** Per-user root: `/tmp/atmux-<uid>`. */
export function userSocketRoot(uid: number): string {
  return join(SOCKET_BASE_DIR, `atmux-${uid}`);
}

/** Per-user team-cage socket: `/tmp/atmux-<uid>/<team>/sock`. */
export function userCageSocketPath(teamName: string, uid: number): string {
  return join(userSocketRoot(uid), teamName, "sock");
}

/** Per-user group-server socket: `/tmp/atmux-<uid>/grp-<group>/sock`.
 *  The `grp-` infix keeps groups out of the team namespace, as before. */
export function userGroupSocketPath(groupName: string, uid: number): string {
  return join(userSocketRoot(uid), `grp-${groupName}`, "sock");
}

/** Pre-ADR-305 shared cage socket: `/tmp/atmux-<team>/sock`. */
export function legacyCageSocketPath(teamName: string): string {
  return join(SOCKET_BASE_DIR, `atmux-${teamName}`, "sock");
}

/** Pre-ADR-305 shared group socket: `/tmp/atmux-grp-<group>/sock`. */
export function legacyGroupSocketPath(groupName: string): string {
  return join(SOCKET_BASE_DIR, `atmux-grp-${groupName}`, "sock");
}

// ---------- Inspection ----------

/** One refusal: which path, what is wrong, and the exact fix. */
export interface SocketPathIssue {
  path: string;
  problem: "symlink" | "not-directory" | "foreign-owner" | "shared-mode" | "uninspectable";
  detail: string;
  hint: string;
}

function octal(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function safeLstat(fs: SocketDirFs, path: string): SocketNodeStat | null {
  try {
    return fs.lstat(path);
  } catch {
    return null;
  }
}

/** Inspect a directory that must be private to `uid`. `null` = absent. */
function inspectDir(
  fs: SocketDirFs,
  path: string,
  uid: number,
): { kind: "absent" } | { kind: "ok" } | { kind: "issue"; issue: SocketPathIssue } {
  let st: SocketNodeStat | null;
  try {
    st = fs.lstat(path);
  } catch (e) {
    return {
      kind: "issue",
      issue: {
        path,
        problem: "uninspectable",
        detail: `cannot be inspected (${errCode(e) ?? String(e)}) — a directory above it is not yours`,
        hint: `atmux only uses socket directories owned by uid ${uid}; remove or rename the directory that blocks ${path}`,
      },
    };
  }
  if (st === null) return { kind: "absent" };
  if (st.isSymbolicLink()) {
    return {
      kind: "issue",
      issue: {
        path,
        problem: "symlink",
        detail: "is a symlink",
        hint: `remove the symlink (rm ${path}); atmux recreates the directory 0700`,
      },
    };
  }
  if (!st.isDirectory()) {
    return {
      kind: "issue",
      issue: {
        path,
        problem: "not-directory",
        detail: "is not a directory",
        hint: `remove it (rm ${path}); atmux recreates the directory 0700`,
      },
    };
  }
  if (st.uid !== uid) {
    return {
      kind: "issue",
      issue: {
        path,
        problem: "foreign-owner",
        detail: `is owned by uid ${st.uid}, not uid ${uid}`,
        hint: `it is not yours — atmux never uses another user's socket directory; have its owner or root remove ${path}`,
      },
    };
  }
  if ((st.mode & GROUP_WORLD_BITS) !== 0) {
    return {
      kind: "issue",
      issue: {
        path,
        problem: "shared-mode",
        detail: `has mode ${octal(st.mode)} (group or world bits set)`,
        hint: `chmod 700 ${path}`,
      },
    };
  }
  return { kind: "ok" };
}

/** The directories that must be private for `socketPath`: its own
 *  directory, plus the per-user root when the path sits in that tree. */
export function privateDirsFor(socketPath: string, uid: number): string[] {
  const leaf = dirname(socketPath);
  const root = userSocketRoot(uid);
  return dirname(leaf) === root ? [root, leaf] : [leaf];
}

/**
 * First reason `socketPath` is unsafe to connect to or create, or `null`
 * when it is safe. Absent directories are safe (nothing there to hijack;
 * tmux reports "no server"). Checks, in order: each private directory
 * (symlink / type / owner / group-world bits), then the socket node's
 * owner. Pure modulo `fs.lstat`.
 */
export function socketPathIssue(
  socketPath: string,
  opts: SocketDirOpts = {},
): SocketPathIssue | null {
  const uid = uidOf(opts);
  if (uid === null) return null;
  const fs = opts.fs ?? realSocketDirFs;
  for (const dir of privateDirsFor(socketPath, uid)) {
    const r = inspectDir(fs, dir, uid);
    if (r.kind === "issue") return r.issue;
    if (r.kind === "absent") return null;
  }
  const node = safeLstat(fs, socketPath);
  if (node === null) return null;
  if (node.isSymbolicLink()) {
    return {
      path: socketPath,
      problem: "symlink",
      detail: "is a symlink",
      hint: `remove it (rm ${socketPath})`,
    };
  }
  if (node.uid !== uid) {
    return {
      path: socketPath,
      problem: "foreign-owner",
      detail: `is owned by uid ${node.uid}, not uid ${uid}`,
      hint: `it is not yours — atmux never connects to another user's tmux server; have its owner or root remove ${socketPath}`,
    };
  }
  return null;
}

/** Refusal thrown by {@link assertSocketPathSafe} and
 *  {@link ensurePrivateSocketDir}. A `ConfigError` (exit 78): the
 *  environment must change before atmux will proceed. */
export class UnsafeSocketPathError extends ConfigError {
  readonly issue: SocketPathIssue;
  readonly socketPath: string;
  constructor(socketPath: string, issue: SocketPathIssue) {
    super({
      what: `refusing tmux socket ${socketPath}: ${issue.path} ${issue.detail}`,
      hint: issue.hint,
    });
    this.issue = issue;
    this.socketPath = socketPath;
  }
}

/** Throw {@link UnsafeSocketPathError} when `socketPath` is unsafe. The
 *  connect-time guard every `createTmux` spawn runs. */
export function assertSocketPathSafe(socketPath: string, opts: SocketDirOpts = {}): void {
  const issue = socketPathIssue(socketPath, opts);
  if (issue !== null) throw new UnsafeSocketPathError(socketPath, issue);
}

/**
 * Create-time: make `dirname(socketPath)` exist, private and ours, then
 * check the socket node. Missing ancestors above the private chain are
 * created 0700; each private directory is created 0700. Every directory
 * this call creates is chmod'ed 0700 right after; an existing directory
 * is never chmod'ed — a bad one is refused ({@link UnsafeSocketPathError}).
 * Returns the private-chain directories this call created.
 */
export function ensurePrivateSocketDir(socketPath: string, opts: SocketDirOpts = {}): string[] {
  const fs = opts.fs ?? realSocketDirFs;
  const uid = uidOf(opts);
  if (uid === null) {
    fs.mkdirp(dirname(socketPath), PRIVATE_DIR_MODE);
    return [];
  }
  const chain = privateDirsFor(socketPath, uid);
  // Missing ancestors above the private chain (e.g. `<root>/.atmux/tmux`
  // for a tmuxTmpdir team): created one level at a time, 0700, and
  // chmod'ed 0700 right after — a `mkdir -p` would leave them at
  // `0700 & ~umask`, which under a restrictive umask is not even
  // writable by the owner. Existing ancestors are never touched.
  const missing: string[] = [];
  for (let d = dirname(chain[0] as string); d !== dirname(d); d = dirname(d)) {
    if (safeLstat(fs, d) !== null) break;
    missing.unshift(d);
  }
  for (const d of missing) {
    if (fs.mkdir(d, PRIVATE_DIR_MODE)) fs.chmod(d, PRIVATE_DIR_MODE);
  }
  const created: string[] = [];
  for (const dir of chain) {
    let r = inspectDir(fs, dir, uid);
    if (r.kind === "absent") {
      if (fs.mkdir(dir, PRIVATE_DIR_MODE)) {
        fs.chmod(dir, PRIVATE_DIR_MODE);
        created.push(dir);
      }
      r = inspectDir(fs, dir, uid);
    }
    if (r.kind === "issue") throw new UnsafeSocketPathError(socketPath, r.issue);
    if (r.kind === "absent") {
      throw new UnsafeSocketPathError(socketPath, {
        path: dir,
        problem: "uninspectable",
        detail: "vanished right after it was created",
        hint: `another process is racing on ${dir}; re-run`,
      });
    }
  }
  assertSocketPathSafe(socketPath, { uid, fs });
  return created;
}

// ---------- Resolution with legacy compatibility ----------

/** Where a pre-ADR-305 socket stands for the current uid. */
export type LegacySocketState =
  /** No socket node at the legacy path (or it cannot be inspected). */
  | "absent"
  /** Ours, and its directory is private — usable as-is. */
  | "adoptable"
  /** Ours, but its directory is shared (wrong mode) — never used. */
  | "shared-dir"
  /** Another uid's socket (or a non-socket node) — never used. */
  | "foreign";

export function legacySocketState(legacyPath: string, opts: SocketDirOpts = {}): LegacySocketState {
  const uid = uidOf(opts);
  const fs = opts.fs ?? realSocketDirFs;
  const node = safeLstat(fs, legacyPath);
  if (node === null) return "absent";
  if (uid === null) return "adoptable";
  if (!node.isSocket() || node.uid !== uid) return "foreign";
  return inspectDir(fs, dirname(legacyPath), uid).kind === "ok" ? "adoptable" : "shared-dir";
}

function isSocketNode(fs: SocketDirFs, path: string): boolean {
  return safeLstat(fs, path)?.isSocket() === true;
}

function pickCompat(userPath: string, legacyPath: string, uid: number, fs: SocketDirFs): string {
  if (isSocketNode(fs, userPath)) return userPath;
  if (legacySocketState(legacyPath, { uid, fs }) === "adoptable") return legacyPath;
  return userPath;
}

/**
 * Resolve a team's default cage socket (no `tmuxTmpdir`). Sync + cheap
 * (≤3 lstat calls) so every verb can call it. Order:
 *   1. per-user socket exists → it;
 *   2. legacy `/tmp/atmux-<team>/sock` is ours in a private dir → legacy
 *      (a live pre-ADR-305 cage keeps working until it restarts);
 *   3. otherwise the per-user path.
 */
export function resolveCageSocketPath(teamName: string, opts: SocketDirOpts = {}): string {
  const uid = uidOf(opts);
  if (uid === null) return legacyCageSocketPath(teamName);
  return pickCompat(
    userCageSocketPath(teamName, uid),
    legacyCageSocketPath(teamName),
    uid,
    opts.fs ?? realSocketDirFs,
  );
}

/** Group-server twin of {@link resolveCageSocketPath}. */
export function resolveGroupSocketPath(groupName: string, opts: SocketDirOpts = {}): string {
  const uid = uidOf(opts);
  if (uid === null) return legacyGroupSocketPath(groupName);
  return pickCompat(
    userGroupSocketPath(groupName, uid),
    legacyGroupSocketPath(groupName),
    uid,
    opts.fs ?? realSocketDirFs,
  );
}

// ---------- Create-time settlement (start / cockpit reconcile) ----------

/** True when something accepts a connection on the unix socket. A tmux
 *  server always does; a dead socket file refuses (ECONNREFUSED). */
export function isSocketListening(path: string, timeoutMs = 500): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const sock = createConnection({ path });
  const done = (live: boolean): void => {
    clearTimeout(timer);
    sock.destroy();
    resolve(live);
  };
  const timer = setTimeout(done, timeoutMs, false);
  sock.once("connect", () => done(true));
  sock.once("error", () => done(false));
  return promise;
}

export interface SettleSocketDeps extends SocketDirOpts {
  isListening?: (path: string) => Promise<boolean>;
  remove?: (path: string) => void;
  log?: (msg: string) => void;
}

/**
 * Pick the socket a CREATING caller (`start`, cockpit group servers)
 * should bind, given the sync-resolved `resolved` and the two candidate
 * paths. Never returns a shared or foreign path:
 *   - legacy socket ours but in a shared dir, and LIVE → refuse (running
 *     a second server on the per-user path would duplicate the cage);
 *     the hint is the chmod that adopts it;
 *   - legacy socket ours in a private dir, and DEAD → remove it and
 *     return the per-user path (the ADR-305 migration);
 *   - otherwise `resolved` unchanged.
 */
export async function settleSocketForCreate(
  resolved: string,
  userPath: string,
  legacyPath: string,
  deps: SettleSocketDeps = {},
): Promise<string> {
  const isListening = deps.isListening ?? isSocketListening;
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const state = legacySocketState(legacyPath, deps);
  if (state === "shared-dir") {
    if (await isListening(legacyPath)) {
      const dir = dirname(legacyPath);
      throw new ConfigError({
        what: `a live tmux server on ${legacyPath} (yours) sits in a shared directory ${dir}; atmux no longer uses shared socket directories`,
        hint: `chmod 700 ${dir} to keep using that server until it next restarts, or stop it (tmux -S ${legacyPath} kill-server) and re-run`,
      });
    }
    return resolved;
  }
  if (state === "adoptable" && resolved === legacyPath && legacyPath !== userPath) {
    if (await isListening(legacyPath)) return legacyPath;
    try {
      (deps.remove ?? defaultRemoveSocket)(legacyPath);
      log(`[atmux] removed dead legacy socket ${legacyPath}; moving to ${userPath} (ADR-305)`);
    } catch (e) {
      log(
        `[atmux] dead legacy socket ${legacyPath} not removed (${String(e)}); moving to ${userPath}`,
      );
    }
    return userPath;
  }
  return resolved;
}

/** Removes one node. The state check before it proved the node is our
 *  own socket (lstat, no follow). */
function defaultRemoveSocket(path: string): void {
  rmSync(path);
}
