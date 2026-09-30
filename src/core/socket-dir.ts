// ADR-305: per-user, private tmux socket directories.
//
// Every `-S <path>` socket atmux creates or connects to lives in a
// directory that only its owner can enter, reached through a chain of
// directories no other uid can rename or rewrite. Measured on @@hax on
// 2026-09-30: `/tmp/atmux-<team>/` directories were mode 0777 with 0777
// sockets, and the `nobody` user could run `tmux -S <sock> has-session`
// against root's live cages — any local user could drive a root shell.
//
// Path scheme (ADR-305 §D1):
//   per-user root   /tmp/atmux-<uid>                  (0700, owned by uid)
//   team cage       /tmp/atmux-<uid>/<team>/sock      (dir 0700)
//   group server    /tmp/atmux-<uid>/grp-<group>/sock (dir 0700)
//   tmuxTmpdir team <tmuxTmpdir>/tmux-<uid>/default   (leaf dir 0700)
//   cockpit         tmux's own $TMUX_TMPDIR/tmux-<uid>/ (-L atmux-cockpit)
//
// The per-user root is one `/tmp` entry, not `/tmp/atmux-<uid>-<team>`:
// a name with a second hyphen matches groom's zombie-fixture sweep
// pattern (`^atmux-…-…$`), which kills the tmux servers it finds.
//
// Whole-chain rule (ADR-305 §D2). The socket path is walked from `/`
// down, one directory at a time, with openat(O_DIRECTORY|O_NOFOLLOW) +
// fstat on the descriptor just opened (Linux: through
// /proc/self/fd/<parent>/<name>, so each step resolves inside the
// directory already checked; the descriptors are held until the walk
// ends). Every directory on the way must be:
//   - a real directory owned by root or by this uid, not writable by
//     group or other — EXCEPT a root-owned sticky directory (`/tmp`,
//     1777), which may be traversed; and
//   - PRIVATE (owned by this uid, no group/other bit at all) when it is
//     the socket's own directory, or an `atmux-*` entry inside such a
//     shared sticky directory (`/tmp/atmux-<uid>`, `/tmp/atmux-tmux_*`,
//     pre-ADR-305 `/tmp/atmux-<team>`).
// A symlink is followed only when it sits in a directory no other uid
// can write (see the non-shared rule above) and is owned by root or this
// uid — macOS `/tmp → private/tmp`; never at a private position, never
// inside a shared directory. Under these rules no other uid can rename,
// replace or re-point any component, so the path atmux hands tmux keeps
// meaning what the walk checked.
//
// Creation: a missing directory is created with mkdir(0700) under umask
// 077 through the parent descriptor, then re-opened and checked like any
// other; nothing is ever chmod'ed. `ensurePrivateSocketDir` (create)
// creates every missing directory; the connect-time guard creates only a
// missing entry of a shared sticky directory (`/tmp/atmux-<uid>`), so no
// other uid can plant it between the check and the dial. An existing
// directory that breaks a rule is refused with the exact fix.
//
// Legacy compatibility (ADR-305 §D3): a cage or group server still on
// the pre-ADR `/tmp/atmux-<team>/sock` path is used only while that
// socket is ours AND its whole chain passes. `start` moves a dead one to
// the per-user path; a live one in an unsafe chain is refused with the
// fix that adopts it.
//
// Removal (ADR-305 revision 4): nothing that deletes or renames a socket
// or a socket directory acts on a path. It walks the chain with the same
// rule, keeps the descriptors, and unlinks / removes / renames relative
// to the held parent directory: a dead socket only when its directory is
// ours alone and a connect() through that descriptor is refused
// (`removeDeadSocket`); a directory tree only when it is ours alone
// (`removePrivateTree`); a directory move only between parents that pass
// the rule (`renameOwnedDir`). A path the walk refuses is never "dead".

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
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
 * Capability marker (ADR-305 §D5). Printed as its own line by
 * `atmux version --features` and carried in the green `socket-dir`
 * doctor row, so a bootstrap can refuse an atmux build that predates
 * per-user private socket directories — or predates a security fix to
 * them:
 *
 *   atmux version --features | grep -qx 'socket-dirs=per-user-0700;rev=4'
 *
 * `socket-dirs=per-user-0700` names the scheme and is never reworded (a
 * successor scheme gets a new name). `;rev=N` counts the security
 * revisions of that scheme: the unreleased first two cuts printed the
 * bare name, so requiring `;rev=N` refuses them; rev 4 removes sockets
 * and socket directories only through held descriptors. Bump N with
 * every fix a consumer must be able to require.
 */
export const SOCKET_DIR_FEATURE_NAME = "socket-dirs=per-user-0700";
export const SOCKET_DIR_REVISION = 4;
export const SOCKET_DIR_FEATURE = `${SOCKET_DIR_FEATURE_NAME};rev=${SOCKET_DIR_REVISION}`;

/** Group + world permission bits. Any of them set ⇒ not private. */
const GROUP_WORLD_BITS = 0o077;
/** Group + world WRITE bits. Any of them set ⇒ shared (others can rename). */
const GROUP_WORLD_WRITE = 0o022;
const STICKY_BIT = 0o1000;
/** Symlink hops one walk follows before refusing (kernel ELOOP is 40). */
export const MAX_SYMLINK_HOPS = 32;

/** The subset of `fs.Stats` the policy reads. */
export interface SocketNodeStat {
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isSocket(): boolean;
}

/** An open directory the walk holds. `path` is where the walk reached it
 *  (symlinks already resolved); `fd` is the descriptor (`-1` in fakes). */
export interface DirHandle {
  readonly path: string;
  readonly fd: number;
}

/**
 * Filesystem seam. Production uses {@link realSocketDirFs}; unit tests
 * inject a fake to drive foreign-owner / symlink / EACCES / race
 * branches that a single-uid process cannot produce on a real disk.
 * Every `*At` call resolves `name` inside the already-open `parent`.
 */
export interface SocketDirFs {
  /** `lstat` by path — classification only (legacy / resolution), never
   *  a security decision. `null` when absent (ENOENT / ENOTDIR). */
  lstat(path: string): SocketNodeStat | null;
  /** `mkdir -p` — only for platforms without a POSIX uid. */
  mkdirp(path: string, mode: number): void;
  /** Open `/`. */
  openRoot(): DirHandle;
  /** openat(parent, name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW). Throws an
   *  errno-coded error (ENOENT, ELOOP, ENOTDIR, EACCES, …). */
  openDirAt(parent: DirHandle, name: string): DirHandle;
  /** fstat of an open directory. */
  fstat(dir: DirHandle): SocketNodeStat;
  /** fstatat(parent, name, AT_SYMLINK_NOFOLLOW); `null` when absent. */
  lstatAt(parent: DirHandle, name: string): SocketNodeStat | null;
  /** readlinkat(parent, name). */
  readlinkAt(parent: DirHandle, name: string): string;
  /** mkdirat(parent, name, 0700) under umask 077. `true` = created,
   *  `false` = something already exists there (EEXIST). */
  mkdirAt(parent: DirHandle, name: string): boolean;
  /** unlinkat(parent, name, 0): one non-directory entry. */
  unlinkAt(parent: DirHandle, name: string): void;
  /** Remove the entry `name` of `parent` and everything below it; a
   *  symlink inside is removed, never followed. */
  removeTreeAt(parent: DirHandle, name: string): void;
  /** renameat(fromParent, fromName, toParent, toName). */
  renameAt(fromParent: DirHandle, fromName: string, toParent: DirHandle, toName: string): void;
  /** connect() to the unix socket `name` inside `parent` (see
   *  {@link probeUnixSocket}). */
  connectAt(parent: DirHandle, name: string, timeoutMs: number): Promise<SocketProbe>;
  close(dir: DirHandle): void;
}

/** What a connect() to a unix socket showed. `dead` is ONLY a refused
 *  connection (ECONNREFUSED: a socket node with no listener); a timeout
 *  or any other error is `unknown`, never `dead`. */
export type SocketProbe = "live" | "dead" | "absent" | "unknown";

function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

function lstatOrNull(read: () => SocketNodeStat): SocketNodeStat | null {
  try {
    return read();
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

const PROC_SELF_FD = "/proc/self/fd";
const DIR_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export interface RealSocketDirFsOpts {
  /** Resolve `*At` names through `/proc/self/fd/<parent>/<name>` (true
   *  openat semantics). Default: Linux with `/proc` mounted. Without it
   *  (macOS, no procfs) names resolve against the parent's walked path;
   *  that path holds no symlink (the walk resolved them) and, by the
   *  chain rule, no component another uid can rename. */
  procFd?: boolean;
}

export function createRealSocketDirFs(opts: RealSocketDirFsOpts = {}): SocketDirFs {
  const procFd = opts.procFd ?? (process.platform === "linux" && existsSync(PROC_SELF_FD));
  const at = (parent: DirHandle, name: string): string =>
    procFd ? `${PROC_SELF_FD}/${parent.fd}/${name}` : join(parent.path, name);
  return {
    lstat(path) {
      return lstatOrNull(() => lstatSync(path));
    },
    mkdirp(path, mode) {
      mkdirSync(path, { recursive: true, mode });
    },
    openRoot() {
      return { path: "/", fd: openSync("/", DIR_OPEN_FLAGS) };
    },
    openDirAt(parent, name) {
      return { path: join(parent.path, name), fd: openSync(at(parent, name), DIR_OPEN_FLAGS) };
    },
    fstat(dir) {
      return fstatSync(dir.fd);
    },
    lstatAt(parent, name) {
      return lstatOrNull(() => lstatSync(at(parent, name)));
    },
    readlinkAt(parent, name) {
      return readlinkSync(at(parent, name));
    },
    unlinkAt(parent, name) {
      unlinkSync(at(parent, name));
    },
    removeTreeAt(parent, name) {
      rmSync(at(parent, name), { recursive: true, force: true });
    },
    renameAt(fromParent, fromName, toParent, toName) {
      renameSync(at(fromParent, fromName), at(toParent, toName));
    },
    connectAt(parent, name, timeoutMs) {
      return probeUnixSocket(at(parent, name), timeoutMs);
    },
    mkdirAt(parent, name) {
      // umask 077 → the directory is exactly 0700 whatever the caller's
      // umask; a restrictive umask cannot leave it unusable either.
      const previous = process.umask(0o077);
      try {
        mkdirSync(at(parent, name), { mode: PRIVATE_DIR_MODE });
        return true;
      } catch (e) {
        if (errCode(e) === "EEXIST") return false;
        throw e;
      } finally {
        process.umask(previous);
      }
    },
    close(dir) {
      closeSync(dir.fd);
    },
  };
}

export const realSocketDirFs: SocketDirFs = createRealSocketDirFs();

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

// ---------- The chain walk ----------

/** One refusal: which path, what is wrong, and the exact fix. */
export interface SocketPathIssue {
  path: string;
  problem:
    | "symlink"
    | "not-directory"
    | "foreign-owner"
    | "shared-mode"
    | "uninspectable"
    | "not-normalized";
  detail: string;
  hint: string;
}

function octal(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

/** What a walk may create. `inspect`: nothing. `connect`: only a missing
 *  entry of a shared sticky directory (the one name another uid could
 *  plant before the dial). `create`: every missing directory. */
type WalkMode = "inspect" | "connect" | "create";

interface Step {
  readonly name: string;
  /** The socket's own directory: owned by this uid, no group/other bit. */
  readonly private: boolean;
}

type WalkResult =
  | { kind: "issue"; issue: SocketPathIssue }
  | {
      kind: "ok";
      /** First directory that does not exist (nothing below it exists
       *  either), or `null`. */
      absentAt: string | null;
      /** lstat of the socket node; `null` when absent. */
      node: SocketNodeStat | null;
      /** Directories this walk created. */
      created: string[];
    };

interface Held {
  readonly dir: DirHandle;
  /** A root-owned sticky directory others may write: its `atmux-*`
   *  entries are private, and a missing entry is created before a dial. */
  shared: boolean;
}

interface Walk {
  readonly fs: SocketDirFs;
  readonly uid: number;
  readonly mode: WalkMode;
  readonly queue: Step[];
  readonly held: Held[];
  readonly created: string[];
  hops: number;
}

function failed(issue: SocketPathIssue): WalkResult {
  return { kind: "issue", issue };
}

interface Split {
  steps: Step[];
  /** The socket's own name, or `null` when the path names a directory. */
  leaf: string | null;
}

/** Split an absolute (or cwd-relative) socket path into directory steps
 *  plus the socket's own name. `.` / `..` components are refused: tmux
 *  resolves them physically, so they would only blur what is checked. */
function socketPathSteps(socketPath: string): Split | SocketPathIssue {
  const abs = socketPath.startsWith("/") ? socketPath : `${process.cwd()}/${socketPath}`;
  const names = abs.split("/").filter((n) => n.length > 0);
  const leaf = names.pop();
  if (
    socketPath === "" ||
    leaf === undefined ||
    [...names, leaf].some((n) => n === "." || n === "..")
  ) {
    return {
      path: socketPath,
      problem: "not-normalized",
      detail: "is not a normalized socket path",
      hint: "use an absolute socket path without '.' or '..' components",
    };
  }
  return { steps: names.map((name, i) => ({ name, private: i === names.length - 1 })), leaf };
}

/** Root or `uid`: the only owners trusted not to swap what they own. */
function trustedOwner(owner: number, uid: number): boolean {
  return owner === 0 || owner === uid;
}

type DirVerdict = { issue: SocketPathIssue } | { shared: boolean };

function checkPrivateDir(path: string, st: SocketNodeStat, uid: number): DirVerdict {
  if (st.uid !== uid) {
    return {
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
      issue: {
        path,
        problem: "shared-mode",
        detail: `has mode ${octal(st.mode)} (group or world bits set)`,
        hint: `chmod 700 ${path}`,
      },
    };
  }
  return { shared: false };
}

/** Apply the chain rule to one opened directory. */
function checkDir(path: string, st: SocketNodeStat, uid: number, priv: boolean): DirVerdict {
  if (priv) return checkPrivateDir(path, st, uid);
  if (!trustedOwner(st.uid, uid)) {
    return {
      issue: {
        path,
        problem: "foreign-owner",
        detail: `is owned by uid ${st.uid} (neither root nor uid ${uid})`,
        hint: `atmux only trusts directories owned by root or uid ${uid} on the way to a socket; move the socket (team.json tmuxTmpdir) under directories you or root own`,
      },
    };
  }
  const writable = (st.mode & GROUP_WORLD_WRITE) !== 0;
  if (writable && !(st.uid === 0 && (st.mode & STICKY_BIT) !== 0)) {
    return {
      issue: {
        path,
        problem: "shared-mode",
        detail: `has mode ${octal(st.mode)} (writable by group or other, and not a root-owned sticky directory)`,
        hint: `another user could rename what lies below ${path}; chmod go-w ${path} (a shared temp directory: root-owned, chmod 1777) or move the socket elsewhere`,
      },
    };
  }
  return { shared: writable };
}

function uninspectable(path: string, e: unknown, uid: number, verb = "opened"): SocketPathIssue {
  return {
    path,
    problem: "uninspectable",
    detail: `cannot be ${verb} (${errCode(e) ?? String(e)})`,
    hint: `every directory on the way to an atmux socket must be a real directory uid ${uid} can search; fix or remove ${path}`,
  };
}

function symlinkIssue(path: string, detail: string): SocketPathIssue {
  return {
    path,
    problem: "symlink",
    detail,
    hint: `atmux follows a symlink only inside a directory no other user can write, owned by root or you, and never as the socket's own directory; replace ${path} with a real directory`,
  };
}

/** Classify a failed open of an entry that exists. */
function openFailure(
  w: Walk,
  parent: DirHandle,
  name: string,
  path: string,
  e: unknown,
): SocketPathIssue {
  const node = w.fs.lstatAt(parent, name);
  if (node?.isSymbolicLink() === true) return symlinkIssue(path, "is a symlink");
  if (node !== null && !node.isDirectory()) {
    return {
      path,
      problem: "not-directory" as const,
      detail: "is not a directory",
      hint: `remove it (rm ${path}); atmux recreates the directory 0700`,
    };
  }
  return uninspectable(path, e, w.uid);
}

type Opened = { dir: DirHandle } | { followed: true } | { result: WalkResult };

/** A missing directory: report it (inspect, or connect below a private
 *  parent — nobody else can create it there), or create it 0700. */
function createMissing(w: Walk, top: Held, name: string, path: string): Opened {
  if (w.mode === "inspect" || (w.mode === "connect" && !top.shared)) {
    return { result: { kind: "ok", absentAt: path, node: null, created: w.created } };
  }
  try {
    if (w.fs.mkdirAt(top.dir, name)) w.created.push(path);
  } catch (e) {
    return { result: failed(uninspectable(path, e, w.uid, "created")) };
  }
  try {
    return { dir: w.fs.openDirAt(top.dir, name) };
  } catch (e) {
    if (errCode(e) !== "ENOENT") return { result: failed(openFailure(w, top.dir, name, path, e)) };
    return {
      result: failed({
        path,
        problem: "uninspectable",
        detail: "vanished right after it was created",
        hint: `another process is racing on ${path}; re-run`,
      }),
    };
  }
}

/** A symlink (or a non-directory) where a directory was expected. A
 *  symlink in a directory no other uid can write, owned by root or this
 *  uid, is followed: its target's components go to the front of the
 *  queue (an absolute target restarts at `/`). Anything else is refused. */
function followLink(
  w: Walk,
  top: Held,
  name: string,
  priv: boolean,
  path: string,
  e: unknown,
): Opened {
  const node = w.fs.lstatAt(top.dir, name);
  if (node?.isSymbolicLink() !== true)
    return { result: failed(openFailure(w, top.dir, name, path, e)) };
  if (priv || top.shared || !trustedOwner(node.uid, w.uid)) {
    return { result: failed(symlinkIssue(path, "is a symlink")) };
  }
  w.hops += 1;
  if (w.hops > MAX_SYMLINK_HOPS) {
    return {
      result: failed(symlinkIssue(path, `is a symlink chain longer than ${MAX_SYMLINK_HOPS} hops`)),
    };
  }
  const target = w.fs.readlinkAt(top.dir, name);
  if (target.startsWith("/")) {
    while (w.held.length > 1) w.fs.close((w.held.pop() as Held).dir);
  }
  const names = target.split("/").filter((n) => n.length > 0);
  w.queue.unshift(...names.map((n) => ({ name: n, private: false })));
  return { followed: true };
}

/** An existing directory this uid cannot open (EACCES, …): name the rule
 *  it breaks when its lstat shows one (another uid's 0700 directory),
 *  else report it as uninspectable. Either way it is a refusal. */
function unopenable(
  w: Walk,
  top: Held,
  name: string,
  priv: boolean,
  path: string,
  e: unknown,
): SocketPathIssue {
  const node = w.fs.lstatAt(top.dir, name);
  if (node?.isDirectory() === true) {
    const verdict = checkDir(path, node, w.uid, priv);
    if ("issue" in verdict) return verdict.issue;
  }
  return uninspectable(path, e, w.uid);
}

function openStep(w: Walk, top: Held, name: string, priv: boolean, path: string): Opened {
  try {
    return { dir: w.fs.openDirAt(top.dir, name) };
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") return createMissing(w, top, name, path);
    if (code === "ELOOP" || code === "ENOTDIR" || code === "EMLINK") {
      return followLink(w, top, name, priv, path, e);
    }
    return { result: failed(unopenable(w, top, name, priv, path, e)) };
  }
}

/** One step of the walk. `null` = keep going. */
function walkStep(w: Walk, step: Step): WalkResult | null {
  const top = w.held[w.held.length - 1] as Held;
  // `.` / `..` only ever come from a followed symlink's target.
  if (step.name === ".") return null;
  if (step.name === "..") {
    if (w.held.length > 1) w.fs.close((w.held.pop() as Held).dir);
    return null;
  }
  // Beneath a shared sticky directory, an `atmux-*` entry is ours alone:
  // another uid could have created it first.
  const priv = step.private || (top.shared && step.name.startsWith("atmux-"));
  const path = join(top.dir.path, step.name);
  const opened = openStep(w, top, step.name, priv, path);
  if ("result" in opened) return opened.result;
  if ("followed" in opened) return null;
  const held: Held = { dir: opened.dir, shared: false };
  w.held.push(held);
  const verdict = checkDir(path, w.fs.fstat(opened.dir), w.uid, priv);
  if ("issue" in verdict) return failed(verdict.issue);
  held.shared = verdict.shared;
  return null;
}

/** The socket node itself: absent, or ours and not a symlink. */
function checkNode(w: Walk, socketPath: string, leaf: string): WalkResult {
  const node = w.fs.lstatAt((w.held[w.held.length - 1] as Held).dir, leaf);
  if (node?.isSymbolicLink() === true) {
    return failed({
      path: socketPath,
      problem: "symlink",
      detail: "is a symlink",
      hint: `remove it (rm ${socketPath})`,
    });
  }
  if (node !== null && node.uid !== w.uid) {
    return failed({
      path: socketPath,
      problem: "foreign-owner",
      detail: `is owned by uid ${node.uid}, not uid ${w.uid}`,
      hint: `it is not yours — atmux never connects to another user's tmux server; have its owner or root remove ${socketPath}`,
    });
  }
  return { kind: "ok", absentAt: null, node, created: w.created };
}

/**
 * Walk `socketPath` from `/` (rules: module header). Holds every opened
 * descriptor until it returns, then closes them all. Any unexpected
 * error is a refusal (fail closed), never a pass.
 */
function walkSocketPath(
  socketPath: string,
  uid: number,
  fs: SocketDirFs,
  mode: WalkMode,
): WalkResult {
  const split = socketPathSteps(socketPath);
  if ("problem" in split) return failed(split);
  return walkChain(split, socketPath, uid, fs, mode);
}

function walkChain(
  split: Split,
  socketPath: string,
  uid: number,
  fs: SocketDirFs,
  mode: WalkMode,
): WalkResult {
  const { r, held } = walkChainHeld(split, socketPath, uid, fs, mode);
  release(fs, held);
  return r;
}

/** A finished walk plus the directories it still holds, root first; the
 *  last one is the socket's own directory when the walk passed. The
 *  caller acts relative to them, then {@link release}s them. */
interface HeldWalk {
  r: WalkResult;
  held: Held[];
}

function walkChainHeld(
  split: Split,
  socketPath: string,
  uid: number,
  fs: SocketDirFs,
  mode: WalkMode,
): HeldWalk {
  const w: Walk = { fs, uid, mode, queue: [...split.steps], held: [], created: [], hops: 0 };
  let r: WalkResult;
  try {
    r = runWalk(w, split, socketPath);
  } catch (e) {
    r = failed(uninspectable(socketPath, e, uid));
  }
  return { r, held: w.held };
}

function runWalk(w: Walk, split: Split, socketPath: string): WalkResult {
  const root = w.fs.openRoot();
  const held: Held = { dir: root, shared: false };
  w.held.push(held);
  // A socket directly under `/` makes `/` its private directory (a walk
  // to a parent directory has no leaf: `/` is then just an ancestor).
  const rootPrivate = split.steps.length === 0 && split.leaf !== null;
  const verdict = checkDir(root.path, w.fs.fstat(root), w.uid, rootPrivate);
  if ("issue" in verdict) return failed(verdict.issue);
  held.shared = verdict.shared;
  for (let step = w.queue.shift(); step !== undefined; step = w.queue.shift()) {
    const r = walkStep(w, step);
    if (r !== null) return r;
  }
  if (split.leaf === null) return { kind: "ok", absentAt: null, node: null, created: w.created };
  return checkNode(w, socketPath, split.leaf);
}

function release(fs: SocketDirFs, held: Held[]): void {
  for (const h of held) fs.close(h.dir);
}

// ---------- Public checks ----------

/**
 * First reason `socketPath` is unsafe, or `null` when it is safe to use.
 * Read-only: nothing is created, and a missing directory is not an issue
 * for INSPECTION (doctor, resolution) — but dialling goes through
 * {@link prepareSocketDial} / {@link assertSocketPathSafe}, which never
 * dial a squattable missing path.
 */
export function socketPathIssue(
  socketPath: string,
  opts: SocketDirOpts = {},
): SocketPathIssue | null {
  const uid = uidOf(opts);
  if (uid === null) return null;
  const r = walkSocketPath(socketPath, uid, opts.fs ?? realSocketDirFs, "inspect");
  return r.kind === "issue" ? r.issue : null;
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

/**
 * Connect-time check (every `createTmux` spawn, `atmux socket-dial`).
 * Walks the whole chain; a missing entry of a shared sticky directory
 * (`/tmp/atmux-<uid>` above all) is created 0700 first, so no other uid
 * can plant it between this check and the dial. Throws
 * {@link UnsafeSocketPathError} on any issue. Returns `true` when a
 * socket node of ours is there to dial.
 */
export function prepareSocketDial(socketPath: string, opts: SocketDirOpts = {}): boolean {
  const fs = opts.fs ?? realSocketDirFs;
  const uid = uidOf(opts);
  if (uid === null) return fs.lstat(socketPath)?.isSocket() === true;
  const r = walkSocketPath(socketPath, uid, fs, "connect");
  if (r.kind === "issue") throw new UnsafeSocketPathError(socketPath, r.issue);
  return r.node?.isSocket() === true;
}

/**
 * Is `dirPath` an existing directory that is ours alone — owned by this
 * uid with no group/other bit, reached through a chain that passes the
 * rule? `null` when it is; the refusal otherwise (a missing directory is
 * a refusal here). Read-only, descriptor-based like every walk. Callers
 * that delete a tree (`test-reaper`) run it right before the removal:
 * once it passes, no other uid can rename any component of the path or
 * plant anything inside the directory.
 */
export function privateDirIssue(dirPath: string, opts: SocketDirOpts = {}): SocketPathIssue | null {
  const uid = uidOf(opts);
  if (uid === null) return null;
  const split = privateDirSplit(dirPath);
  if ("problem" in split) return split;
  const r = walkChain(split, dirPath, uid, opts.fs ?? realSocketDirFs, "inspect");
  if (r.kind === "issue") return r.issue;
  return r.absentAt === null ? null : absentIssue(r.absentAt, dirPath);
}

/** The walk steps of a directory whose last component must be private.
 *  `/` itself is refused: it has no parent to act relative to. */
function privateDirSplit(dirPath: string): Split | SocketPathIssue {
  const split = socketPathSteps(`${dirPath}/.probe`);
  if ("problem" in split) return { ...split, path: dirPath };
  if (split.steps.length === 0) {
    return {
      path: dirPath,
      problem: "not-normalized",
      detail: "is the root directory",
      hint: "name a directory below /",
    };
  }
  return { steps: split.steps, leaf: null };
}

function absentIssue(absentAt: string, dirPath: string): SocketPathIssue {
  return {
    path: absentAt,
    problem: "uninspectable",
    detail: "does not exist",
    hint: `nothing to act on under ${dirPath}`,
  };
}

function noUidIssue(path: string): SocketPathIssue {
  return {
    path,
    problem: "uninspectable",
    detail: "cannot be checked (no POSIX uid on this platform)",
    hint: "remove it by hand",
  };
}

/** The directory the walk ended in (the last one it holds). */
function heldTop(held: Held[]): DirHandle {
  return (held[held.length - 1] as Held).dir;
}

/** Why {@link removeDeadSocket} left a socket in place. */
export type DeadSocketRemoval =
  | { removed: true }
  | { removed: false; reason: "unsafe"; issue: SocketPathIssue }
  | { removed: false; reason: "absent" | "not-socket" | "live" | "unknown" };

export interface RemoveDeadSocketOpts extends SocketDirOpts {
  /** connect() timeout; a timeout is `unknown`, never dead. Default 500. */
  timeoutMs?: number;
}

/**
 * Delete a DEAD socket of ours (ADR-305 revision 4). The whole chain is
 * walked with the rule, the socket's own directory must be ours alone
 * (the {@link privateDirIssue} rule, checked by the same walk that keeps
 * its descriptor), the node must be our socket — then connect() runs
 * through that descriptor (`/proc/self/fd/<dir>/<name>` on Linux) and
 * only a refused connection (ECONNREFUSED) counts as dead. The unlink
 * runs relative to the same descriptor. A path the walk refuses is
 * `unsafe`: nothing is removed.
 */
export async function removeDeadSocket(
  socketPath: string,
  opts: RemoveDeadSocketOpts = {},
): Promise<DeadSocketRemoval> {
  const uid = uidOf(opts);
  if (uid === null) return { removed: false, reason: "unsafe", issue: noUidIssue(socketPath) };
  const fs = opts.fs ?? realSocketDirFs;
  const split = socketPathSteps(socketPath);
  if ("problem" in split) return { removed: false, reason: "unsafe", issue: split };
  const leaf = split.leaf as string;
  const { r, held } = walkChainHeld(split, socketPath, uid, fs, "inspect");
  try {
    if (r.kind === "issue") return { removed: false, reason: "unsafe", issue: r.issue };
    // checkNode already refused a symlink or another uid's node.
    if (r.node === null) return { removed: false, reason: "absent" };
    if (!r.node.isSocket()) return { removed: false, reason: "not-socket" };
    const dir = heldTop(held);
    const probe = await fs.connectAt(dir, leaf, opts.timeoutMs ?? 500);
    if (probe !== "dead") return { removed: false, reason: probe };
    fs.unlinkAt(dir, leaf);
    return { removed: true };
  } finally {
    release(fs, held);
  }
}

/** One line for a log: why a socket was left in place. */
export function describeSocketRemoval(out: Exclude<DeadSocketRemoval, { removed: true }>): string {
  switch (out.reason) {
    case "unsafe":
      return `unsafe: ${out.issue.path} ${out.issue.detail}`;
    case "absent":
      return "no socket there";
    case "not-socket":
      return "not a socket";
    case "live":
      return "a server accepts connections on it";
    case "unknown":
      return "its connect probe was inconclusive";
  }
}

/**
 * Remove the directory `dirPath` and everything in it — only when the
 * {@link privateDirIssue} walk shows it is ours alone. The walk keeps
 * the descriptors and the removal runs relative to the held parent, so
 * no rename after the check can redirect it; inside a private directory
 * only this uid can have planted anything. Throws
 * {@link UnsafeSocketPathError} on a refusal; `false` when it is absent.
 */
export function removePrivateTree(dirPath: string, opts: SocketDirOpts = {}): boolean {
  const uid = uidOf(opts);
  if (uid === null) throw new UnsafeSocketPathError(dirPath, noUidIssue(dirPath));
  const fs = opts.fs ?? realSocketDirFs;
  const split = privateDirSplit(dirPath);
  if ("problem" in split) throw new UnsafeSocketPathError(dirPath, split);
  const { r, held } = walkChainHeld(split, dirPath, uid, fs, "inspect");
  try {
    if (r.kind === "issue") throw new UnsafeSocketPathError(dirPath, r.issue);
    if (r.absentAt !== null) return false;
    // A private step is never reached through a symlink, so the held
    // directory below the top is its parent and its name is the last step.
    const parent = (held[held.length - 2] as Held).dir;
    fs.removeTreeAt(parent, (split.steps[split.steps.length - 1] as Step).name);
    return true;
  } finally {
    release(fs, held);
  }
}

/** Walk to the parent of `path` (ancestor rule, nothing created), keep
 *  it, and return it with the entry name — or the refusal. */
function walkToParent(
  path: string,
  uid: number,
  fs: SocketDirFs,
): { held: Held[]; name: string } | { issue: SocketPathIssue } {
  const split = socketPathSteps(path);
  if ("problem" in split) return { issue: split };
  const parentSplit: Split = {
    steps: split.steps.map((st) => ({ name: st.name, private: false })),
    leaf: null,
  };
  const { r, held } = walkChainHeld(parentSplit, path, uid, fs, "inspect");
  if (r.kind === "issue" || r.absentAt !== null) {
    release(fs, held);
    return {
      issue: r.kind === "issue" ? r.issue : absentIssue(r.absentAt as string, path),
    };
  }
  return { held, name: split.leaf as string };
}

/**
 * Move directory `from` to `to` (team repair-rename's tmpdir move) with
 * renameat relative to held parents: both parent chains must pass the
 * rule, `from` must be a real directory owned by this uid, and nothing
 * may exist at `to`. Throws {@link UnsafeSocketPathError}.
 */
export function renameOwnedDir(from: string, to: string, opts: SocketDirOpts = {}): void {
  const uid = uidOf(opts);
  if (uid === null) throw new UnsafeSocketPathError(from, noUidIssue(from));
  const fs = opts.fs ?? realSocketDirFs;
  const src = walkToParent(from, uid, fs);
  if ("issue" in src) throw new UnsafeSocketPathError(from, src.issue);
  try {
    const node = fs.lstatAt(heldTop(src.held), src.name);
    if (node === null || !node.isDirectory() || node.uid !== uid) {
      throw new UnsafeSocketPathError(from, {
        path: from,
        problem:
          node === null ? "uninspectable" : node.uid !== uid ? "foreign-owner" : "not-directory",
        detail:
          node === null
            ? "does not exist"
            : node.uid !== uid
              ? `is owned by uid ${node.uid}, not uid ${uid}`
              : "is not a real directory",
        hint: `move only a directory of yours; inspect ${from}`,
      });
    }
    const dst = walkToParent(to, uid, fs);
    if ("issue" in dst) throw new UnsafeSocketPathError(to, dst.issue);
    try {
      if (fs.lstatAt(heldTop(dst.held), dst.name) !== null) {
        throw new UnsafeSocketPathError(to, {
          path: to,
          problem: "uninspectable",
          detail: "already exists",
          hint: `refusing to clobber ${to}; inspect it`,
        });
      }
      fs.renameAt(heldTop(src.held), src.name, heldTop(dst.held), dst.name);
    } finally {
      release(fs, dst.held);
    }
  } finally {
    release(fs, src.held);
  }
}

/** {@link prepareSocketDial} without the answer: the guard `createTmux`
 *  runs before every spawn. */
export function assertSocketPathSafe(socketPath: string, opts: SocketDirOpts = {}): void {
  prepareSocketDial(socketPath, opts);
}

/**
 * Create-time: make `dirname(socketPath)` exist, private and ours, with
 * a chain that passes the rule, then check the socket node. Every
 * missing directory is created mkdir(0700) under umask 077 and then
 * verified through its descriptor; nothing is chmod'ed. Throws
 * {@link UnsafeSocketPathError}. Returns the directories it created.
 */
export function ensurePrivateSocketDir(socketPath: string, opts: SocketDirOpts = {}): string[] {
  const fs = opts.fs ?? realSocketDirFs;
  const uid = uidOf(opts);
  if (uid === null) {
    fs.mkdirp(dirname(socketPath), PRIVATE_DIR_MODE);
    return [];
  }
  const r = walkSocketPath(socketPath, uid, fs, "create");
  if (r.kind === "issue") throw new UnsafeSocketPathError(socketPath, r.issue);
  return r.created;
}

// ---------- Resolution with legacy compatibility ----------

/** Where a pre-ADR-305 socket stands for the current uid. */
export type LegacySocketState =
  /** No socket node at the legacy path (or it cannot be inspected). */
  | "absent"
  /** Ours, and its whole chain passes — usable as-is. */
  | "adoptable"
  /** Ours, but its chain fails the rule (a shared directory) — never used. */
  | "shared-dir"
  /** Another uid's socket (or a non-socket node) — never used. */
  | "foreign";

function safeLstat(fs: SocketDirFs, path: string): SocketNodeStat | null {
  try {
    return fs.lstat(path);
  } catch {
    return null;
  }
}

/** {@link LegacySocketState} plus, for `shared-dir`, the chain issue. */
export type LegacySocketInfo =
  | { state: "absent" | "adoptable" | "foreign" }
  | { state: "shared-dir"; issue: SocketPathIssue };

export function legacySocketInfo(legacyPath: string, opts: SocketDirOpts = {}): LegacySocketInfo {
  const uid = uidOf(opts);
  const fs = opts.fs ?? realSocketDirFs;
  if (uid === null) return { state: safeLstat(fs, legacyPath) === null ? "absent" : "adoptable" };
  const r = walkSocketPath(legacyPath, uid, fs, "inspect");
  if (r.kind === "ok") {
    if (r.node === null) return { state: "absent" };
    return { state: r.node.isSocket() ? "adoptable" : "foreign" };
  }
  // Only a directory of OURS whose mode is too open is the pre-ADR-305
  // shape `start` reports loudly; a symlink, another uid's directory or
  // node, or anything else is not ours to report on. This path lstat
  // only chooses which refusal to print — nothing is used or removed.
  if (r.issue.problem !== "shared-mode") return { state: "foreign" };
  const node = safeLstat(fs, legacyPath);
  if (node === null) return { state: "absent" };
  if (!node.isSocket() || node.uid !== uid) return { state: "foreign" };
  return { state: "shared-dir", issue: r.issue };
}

export function legacySocketState(legacyPath: string, opts: SocketDirOpts = {}): LegacySocketState {
  return legacySocketInfo(legacyPath, opts).state;
}

/** Our socket at `path`, reached through a chain that passes the rule —
 *  the descriptor walk, never a path lstat (which would follow another
 *  uid's symlink in the middle of the path). */
function ownSocketAt(fs: SocketDirFs, path: string, uid: number): boolean {
  const r = walkSocketPath(path, uid, fs, "inspect");
  return r.kind === "ok" && r.node?.isSocket() === true;
}

/** {@link ownSocketAt} for callers outside this module (the legacy
 *  socket gate in `tmux-paths.ts`). */
export function isOwnSocket(path: string, opts: SocketDirOpts = {}): boolean {
  const uid = uidOf(opts);
  const fs = opts.fs ?? realSocketDirFs;
  if (uid === null) return safeLstat(fs, path)?.isSocket() === true;
  return ownSocketAt(fs, path, uid);
}

function pickCompat(userPath: string, legacyPath: string, uid: number, fs: SocketDirFs): string {
  if (ownSocketAt(fs, userPath, uid)) return userPath;
  if (legacySocketState(legacyPath, { uid, fs }) === "adoptable") return legacyPath;
  return userPath;
}

/**
 * Resolve a team's default cage socket (no `tmuxTmpdir`). Sync + cheap
 * so every verb can call it. Order:
 *   1. per-user socket of ours with a passing chain → it;
 *   2. legacy `/tmp/atmux-<team>/sock` is ours with a passing chain →
 *      legacy (a live pre-ADR-305 cage keeps working until it restarts);
 *   3. otherwise the per-user path.
 * Resolution only picks a path; every dial is still guarded.
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

/** connect() to a unix socket: `live` when it accepts (a tmux server
 *  always does), `dead` only on ECONNREFUSED, `absent` on ENOENT, and
 *  `unknown` on a timeout or any other error. */
export function probeUnixSocket(path: string, timeoutMs = 500): Promise<SocketProbe> {
  const { promise, resolve } = Promise.withResolvers<SocketProbe>();
  const sock = createConnection({ path });
  const done = (out: SocketProbe): void => {
    clearTimeout(timer);
    sock.destroy();
    resolve(out);
  };
  const timer = setTimeout(done, timeoutMs, "unknown");
  sock.once("connect", () => done("live"));
  sock.once("error", (e) => {
    const code = errCode(e);
    done(code === "ECONNREFUSED" ? "dead" : code === "ENOENT" ? "absent" : "unknown");
  });
  return promise;
}

/** True when something accepts a connection on the unix socket. */
export async function isSocketListening(path: string, timeoutMs = 500): Promise<boolean> {
  return (await probeUnixSocket(path, timeoutMs)) === "live";
}

export interface SettleSocketDeps extends SocketDirOpts {
  isListening?: (path: string) => Promise<boolean>;
  /** Delete the dead legacy socket (a returned promise is awaited);
   *  throws to report why it did not. Default: {@link removeDeadSocket}
   *  (descriptor-based). */
  remove?: (path: string) => unknown;
  log?: (msg: string) => void;
}

/**
 * Pick the socket a CREATING caller (`start`, cockpit group servers)
 * should bind, given the sync-resolved `resolved` and the two candidate
 * paths. Never returns an unsafe or foreign path:
 *   - legacy socket ours but its chain fails, and LIVE → refuse (running
 *     a second server on the per-user path would duplicate the cage);
 *     the hint is the fix that adopts it;
 *   - legacy socket ours with a passing chain, and DEAD → remove it and
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
  const info = legacySocketInfo(legacyPath, deps);
  if (info.state === "shared-dir") {
    if (await isListening(legacyPath)) {
      throw new ConfigError({
        what: `a live tmux server on ${legacyPath} (yours) sits in an unsafe directory chain: ${info.issue.path} ${info.issue.detail}; atmux no longer uses shared socket directories`,
        hint: `${info.issue.hint} — that keeps the server usable until it next restarts; or stop it (atmux socket-dial ${legacyPath} kill-server) and re-run`,
      });
    }
    return resolved;
  }
  if (info.state === "adoptable" && resolved === legacyPath && legacyPath !== userPath) {
    if (await isListening(legacyPath)) return legacyPath;
    try {
      await (deps.remove ?? ((p: string) => removeDeadSocketOrThrow(p, deps)))(legacyPath);
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

/** {@link removeDeadSocket} for a seam that reports by throwing: the
 *  error says why the socket was left in place. */
export async function removeDeadSocketOrThrow(
  path: string,
  opts: RemoveDeadSocketOpts = {},
): Promise<void> {
  const out = await removeDeadSocket(path, opts);
  if (!out.removed) throw new Error(describeSocketRemoval(out));
}
