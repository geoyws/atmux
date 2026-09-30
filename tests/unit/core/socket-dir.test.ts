// ADR-305 — per-user private socket directories (src/core/socket-dir.ts).
//
// Two layers:
//   - a FAKE filesystem drives what one uid cannot produce on a real disk
//     (another uid's directory, another uid's socket, EACCES, races);
//   - the REAL filesystem (mkdtemp scratch) proves the modes: created 0700
//     under any umask, an existing wide directory refused and left
//     untouched, a planted symlink refused.
// Read bottom-up: every refusal asserts the exact problem + hint, so an
// implementation that stopped checking (or started chmod'ing) fails here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSocketPathSafe,
  currentUid,
  ensurePrivateSocketDir,
  isSocketListening,
  legacyCageSocketPath,
  legacyGroupSocketPath,
  legacySocketState,
  PRIVATE_DIR_MODE,
  privateDirsFor,
  realSocketDirFs,
  resolveCageSocketPath,
  resolveGroupSocketPath,
  SOCKET_BASE_DIR,
  SOCKET_DIR_FEATURE,
  type SocketDirFs,
  type SocketNodeStat,
  settleSocketForCreate,
  socketPathIssue,
  UnsafeSocketPathError,
  userCageSocketPath,
  userGroupSocketPath,
  userSocketRoot,
} from "../../../src/core/socket-dir.ts";
import { ConfigError } from "../../../src/errors.ts";

// ---------- fake filesystem ----------

type Kind = "dir" | "socket" | "file" | "symlink";
interface Node {
  kind: Kind;
  uid: number;
  mode: number;
}

function stat(n: Node): SocketNodeStat {
  return {
    uid: n.uid,
    mode: n.mode,
    isDirectory: () => n.kind === "dir",
    isSymbolicLink: () => n.kind === "symlink",
    isSocket: () => n.kind === "socket",
  };
}

interface FakeFs extends SocketDirFs {
  nodes: Map<string, Node>;
  calls: string[];
}

/** Map-backed fs. `mkdir` creates as `creatorUid` with `mode & ~umask`. */
function fakeFs(
  nodes: Record<string, Node> = {},
  opts: {
    creatorUid?: number;
    umask?: number;
    throwOn?: Record<string, string>;
    /** mkdir(path) reports EEXIST and plants this node instead. */
    raceOn?: Record<string, Node>;
    /** lstat of these paths returns null AFTER mkdir created them. */
    vanishOn?: Set<string>;
  } = {},
): FakeFs {
  const map = new Map(Object.entries(nodes));
  const calls: string[] = [];
  const umask = opts.umask ?? 0o022;
  return {
    nodes: map,
    calls,
    lstat(path) {
      calls.push(`lstat ${path}`);
      const code = opts.throwOn?.[path];
      if (code !== undefined) throw Object.assign(new Error(code), { code });
      if (opts.vanishOn?.has(path) && calls.includes(`mkdir ${path}`)) return null;
      const n = map.get(path);
      return n === undefined ? null : stat(n);
    },
    mkdir(path, mode) {
      calls.push(`mkdir ${path}`);
      const race = opts.raceOn?.[path];
      if (race !== undefined) {
        map.set(path, race);
        return false;
      }
      if (map.has(path)) return false;
      map.set(path, { kind: "dir", uid: opts.creatorUid ?? 1000, mode: mode & ~umask });
      return true;
    },
    mkdirp(path, mode) {
      calls.push(`mkdirp ${path} ${mode.toString(8)}`);
    },
    chmod(path, mode) {
      calls.push(`chmod ${path} ${mode.toString(8)}`);
      const n = map.get(path);
      if (n !== undefined) n.mode = mode;
    },
  };
}

const dir = (uid: number, mode = 0o700): Node => ({ kind: "dir", uid, mode });
const sock = (uid: number, mode = 0o660): Node => ({ kind: "socket", uid, mode });

const A = 1000;
const B = 1001;

// ---------- paths ----------

describe("per-user path scheme (ADR-305 §D1)", () => {
  test("two uids get distinct roots, cage sockets and group sockets", () => {
    expect(SOCKET_BASE_DIR).toBe("/tmp");
    expect(userSocketRoot(0)).toBe("/tmp/atmux-0");
    expect(userSocketRoot(A)).toBe("/tmp/atmux-1000");
    expect(userCageSocketPath("px", 0)).toBe("/tmp/atmux-0/px/sock");
    expect(userCageSocketPath("px", A)).toBe("/tmp/atmux-1000/px/sock");
    expect(userCageSocketPath("px", 0)).not.toBe(userCageSocketPath("px", A));
    expect(userGroupSocketPath("unum", 0)).toBe("/tmp/atmux-0/grp-unum/sock");
    expect(userGroupSocketPath("unum", A)).toBe("/tmp/atmux-1000/grp-unum/sock");
  });

  test("pre-ADR-305 legacy shapes are unchanged", () => {
    expect(legacyCageSocketPath("px")).toBe("/tmp/atmux-px/sock");
    expect(legacyGroupSocketPath("unum")).toBe("/tmp/atmux-grp-unum/sock");
  });

  test("privateDirsFor: per-user tree checks root + leaf, anything else the leaf only", () => {
    expect(privateDirsFor("/tmp/atmux-1000/px/sock", A)).toEqual([
      "/tmp/atmux-1000",
      "/tmp/atmux-1000/px",
    ]);
    expect(privateDirsFor("/r/.atmux/tmux/tmux-1000/default", A)).toEqual([
      "/r/.atmux/tmux/tmux-1000",
    ]);
    // Another uid's tree is NOT treated as ours: only its leaf is checked
    // (and the leaf's owner check then refuses it).
    expect(privateDirsFor("/tmp/atmux-1001/px/sock", A)).toEqual(["/tmp/atmux-1001/px"]);
  });

  test("currentUid reports the process uid", () => {
    expect(currentUid()).toBe(process.getuid?.() ?? null);
  });

  test("stable capability marker", () => {
    expect(SOCKET_DIR_FEATURE).toBe("socket-dirs=per-user-0700");
  });
});

// ---------- socketPathIssue / assertSocketPathSafe ----------

describe("socketPathIssue — refusal matrix", () => {
  const S = "/tmp/atmux-1000/px/sock";

  test("absent directory → safe (nothing there to hijack)", () => {
    expect(socketPathIssue(S, { uid: A, fs: fakeFs() })).toBeNull();
  });

  test("root present, leaf absent → safe", () => {
    expect(socketPathIssue(S, { uid: A, fs: fakeFs({ "/tmp/atmux-1000": dir(A) }) })).toBeNull();
  });

  test("private chain, no socket yet → safe", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A) });
    expect(socketPathIssue(S, { uid: A, fs })).toBeNull();
  });

  test("private chain + own socket → safe", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A), [S]: sock(A) });
    expect(socketPathIssue(S, { uid: A, fs })).toBeNull();
  });

  test("per-user root squatted by another uid → foreign-owner", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(B, 0o777) });
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue?.problem).toBe("foreign-owner");
    expect(issue?.path).toBe("/tmp/atmux-1000");
    expect(issue?.detail).toBe("is owned by uid 1001, not uid 1000");
    expect(issue?.hint).toContain("never uses another user's socket directory");
  });

  for (const mode of [0o777, 0o755, 0o750, 0o710, 0o701, 0o770, 0o707]) {
    test(`leaf mode 0${mode.toString(8)} (group/world rwx or search) → shared-mode`, () => {
      const fs = fakeFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A, mode) });
      const issue = socketPathIssue(S, { uid: A, fs });
      expect(issue?.problem).toBe("shared-mode");
      expect(issue?.path).toBe("/tmp/atmux-1000/px");
      expect(issue?.detail).toBe(`has mode 0${mode.toString(8)} (group or world bits set)`);
      expect(issue?.hint).toBe("chmod 700 /tmp/atmux-1000/px");
    });
  }

  test("owner-only narrower modes (0500) are private", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(A, 0o500), "/tmp/atmux-1000/px": dir(A, 0o700) });
    expect(socketPathIssue(S, { uid: A, fs })).toBeNull();
  });

  test("leaf is a symlink → refused", () => {
    const fs = fakeFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": { kind: "symlink", uid: A, mode: 0o777 },
    });
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue?.problem).toBe("symlink");
    expect(issue?.hint).toBe(
      "remove the symlink (rm /tmp/atmux-1000/px); atmux recreates the directory 0700",
    );
  });

  test("leaf is a regular file → not-directory", () => {
    const fs = fakeFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": { kind: "file", uid: A, mode: 0o600 },
    });
    expect(socketPathIssue(S, { uid: A, fs })?.problem).toBe("not-directory");
  });

  test("lstat EACCES (a directory above is not ours) → uninspectable", () => {
    const fs = fakeFs(
      { "/tmp/atmux-1000": dir(A) },
      { throwOn: { "/tmp/atmux-1000/px": "EACCES" } },
    );
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue?.problem).toBe("uninspectable");
    expect(issue?.detail).toContain("EACCES");
  });

  test("lstat failure without an errno code still refuses", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(A) });
    fs.lstat = (p) => {
      if (p === "/tmp/atmux-1000/px") throw "boom";
      return stat(dir(A));
    };
    expect(socketPathIssue(S, { uid: A, fs })?.detail).toContain("boom");
  });

  test("planted socket owned by another uid inside a private dir → foreign-owner", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A), [S]: sock(0) });
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue?.problem).toBe("foreign-owner");
    expect(issue?.path).toBe(S);
    expect(issue?.hint).toContain("never connects to another user's tmux server");
  });

  test("socket path is a symlink → refused", () => {
    const fs = fakeFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: { kind: "symlink", uid: A, mode: 0o777 },
    });
    expect(socketPathIssue(S, { uid: A, fs })?.problem).toBe("symlink");
  });

  test("tmuxTmpdir layout: only the tmux-<uid> leaf is checked", () => {
    const P = "/r/.atmux/tmux/tmux-1000/default";
    expect(
      socketPathIssue(P, { uid: A, fs: fakeFs({ "/r/.atmux/tmux/tmux-1000": dir(A) }) }),
    ).toBeNull();
    const shared = fakeFs({ "/r/.atmux/tmux/tmux-1000": dir(A, 0o777) });
    expect(socketPathIssue(P, { uid: A, fs: shared })?.problem).toBe("shared-mode");
  });

  test("no POSIX uid → checks off", () => {
    expect(
      socketPathIssue(S, { uid: null, fs: fakeFs({ "/tmp/atmux-1000": dir(B, 0o777) }) }),
    ).toBeNull();
  });

  test("assertSocketPathSafe throws UnsafeSocketPathError (a ConfigError) carrying the issue", () => {
    const fs = fakeFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A, 0o777) });
    let caught: unknown;
    try {
      assertSocketPathSafe(S, { uid: A, fs });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsafeSocketPathError);
    expect(caught).toBeInstanceOf(ConfigError);
    const err = caught as UnsafeSocketPathError;
    expect(err.tag).toBe("config");
    expect(err.socketPath).toBe(S);
    expect(err.issue.problem).toBe("shared-mode");
    expect(err.message).toBe(
      "refusing tmux socket /tmp/atmux-1000/px/sock: /tmp/atmux-1000/px has mode 0777 (group or world bits set) (hint: chmod 700 /tmp/atmux-1000/px)",
    );
  });

  test("assertSocketPathSafe is silent on a safe path", () => {
    expect(() => assertSocketPathSafe(S, { uid: A, fs: fakeFs() })).not.toThrow();
  });
});

// ---------- ensurePrivateSocketDir (fake fs) ----------

describe("ensurePrivateSocketDir — creation chain (fake fs)", () => {
  const S = "/tmp/atmux-1000/px/sock";

  test("creates root + leaf 0700 and chmods only what it created", () => {
    const fs = fakeFs({ "/tmp": dir(0, 0o1777) }, { creatorUid: A, umask: 0o022 });
    const created = ensurePrivateSocketDir(S, { uid: A, fs });
    expect(created).toEqual(["/tmp/atmux-1000", "/tmp/atmux-1000/px"]);
    expect(fs.nodes.get("/tmp/atmux-1000")?.mode).toBe(PRIVATE_DIR_MODE);
    expect(fs.nodes.get("/tmp/atmux-1000/px")?.mode).toBe(PRIVATE_DIR_MODE);
    expect(fs.calls.filter((c) => c.startsWith("chmod"))).toEqual([
      "chmod /tmp/atmux-1000 700",
      "chmod /tmp/atmux-1000/px 700",
    ]);
    // `/tmp` exists → no mkdir -p of the base.
    expect(fs.calls.some((c) => c.startsWith("mkdirp"))).toBe(false);
  });

  test("existing private root is reused, never chmod'ed", () => {
    const fs = fakeFs({ "/tmp": dir(0, 0o1777), "/tmp/atmux-1000": dir(A) }, { creatorUid: A });
    expect(ensurePrivateSocketDir(S, { uid: A, fs })).toEqual(["/tmp/atmux-1000/px"]);
    expect(fs.calls).not.toContain("chmod /tmp/atmux-1000 700");
  });

  test("existing wide root is refused and NOT chmod'ed", () => {
    const fs = fakeFs(
      { "/tmp": dir(0, 0o1777), "/tmp/atmux-1000": dir(A, 0o777) },
      { creatorUid: A },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(UnsafeSocketPathError);
    expect(fs.nodes.get("/tmp/atmux-1000")?.mode).toBe(0o777);
    expect(fs.calls.some((c) => c.startsWith("chmod"))).toBe(false);
  });

  test("root squatted by another uid → refused before any team dir is made", () => {
    const fs = fakeFs(
      { "/tmp": dir(0, 0o1777), "/tmp/atmux-1000": dir(B, 0o700) },
      { creatorUid: A },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      /owned by uid 1001, not uid 1000/,
    );
    expect(fs.nodes.has("/tmp/atmux-1000/px")).toBe(false);
  });

  test("race: mkdir hits EEXIST on a directory another uid just planted → refused", () => {
    const fs = fakeFs(
      { "/tmp": dir(0, 0o1777) },
      { creatorUid: A, raceOn: { "/tmp/atmux-1000": dir(B, 0o777) } },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(/owned by uid 1001/);
    expect(fs.calls.some((c) => c.startsWith("chmod"))).toBe(false);
  });

  test("directory vanishing right after creation is refused, not assumed", () => {
    const fs = fakeFs(
      { "/tmp": dir(0, 0o1777) },
      { creatorUid: A, vanishOn: new Set(["/tmp/atmux-1000"]) },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      /vanished right after it was created/,
    );
  });

  test("a planted foreign socket in the (private) leaf is refused after the dirs pass", () => {
    const fs = fakeFs(
      {
        "/tmp": dir(0, 0o1777),
        "/tmp/atmux-1000": dir(A),
        "/tmp/atmux-1000/px": dir(A),
        [S]: sock(B),
      },
      { creatorUid: A },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      /px\/sock is owned by uid 1001/,
    );
  });

  test("missing ancestors above a tmuxTmpdir leaf are created top-down, each 0700", () => {
    const P = "/r/.atmux/tmux/tmux-1000/default";
    const fs = fakeFs({}, { creatorUid: A, umask: 0o277 });
    expect(ensurePrivateSocketDir(P, { uid: A, fs })).toEqual(["/r/.atmux/tmux/tmux-1000"]);
    const made = fs.calls.filter((c) => c.startsWith("mkdir ") || c.startsWith("chmod "));
    expect(made).toEqual([
      "mkdir /r",
      "chmod /r 700",
      "mkdir /r/.atmux",
      "chmod /r/.atmux 700",
      "mkdir /r/.atmux/tmux",
      "chmod /r/.atmux/tmux 700",
      "mkdir /r/.atmux/tmux/tmux-1000",
      "chmod /r/.atmux/tmux/tmux-1000 700",
    ]);
    for (const d of ["/r", "/r/.atmux", "/r/.atmux/tmux", "/r/.atmux/tmux/tmux-1000"]) {
      expect(fs.nodes.get(d)?.mode).toBe(0o700);
    }
  });

  test("an existing ancestor stops the walk and is never chmod'ed", () => {
    const P = "/r/.atmux/tmux/tmux-1000/default";
    const fs = fakeFs({ "/r": dir(A, 0o755) }, { creatorUid: A });
    ensurePrivateSocketDir(P, { uid: A, fs });
    expect(fs.calls).not.toContain("mkdir /r");
    expect(fs.calls).not.toContain("chmod /r 700");
    expect(fs.nodes.get("/r")?.mode).toBe(0o755);
  });

  test("an ancestor that already exists at mkdir time (EEXIST) is not chmod'ed", () => {
    const P = "/r/.atmux/tmux/tmux-1000/default";
    const fs = fakeFs({}, { creatorUid: A, raceOn: { "/r": dir(B, 0o1777) } });
    ensurePrivateSocketDir(P, { uid: A, fs });
    expect(fs.calls).not.toContain("chmod /r 700");
  });

  test("no POSIX uid → plain mkdir -p 0700 of the socket's directory", () => {
    const fs = fakeFs();
    expect(ensurePrivateSocketDir("/x/y/sock", { uid: null, fs })).toEqual([]);
    expect(fs.calls).toEqual(["mkdirp /x/y 700"]);
  });
});

// ---------- ensurePrivateSocketDir (real fs: modes) ----------

describe("ensurePrivateSocketDir — real filesystem modes", () => {
  let scratch: string;
  const uid = process.getuid?.() ?? 0;
  let savedUmask: number;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-sockdir-"));
    savedUmask = process.umask();
  });
  afterEach(async () => {
    process.umask(savedUmask);
    await rm(scratch, { recursive: true, force: true });
  });

  const modeOf = (p: string): number => statSync(p).mode & 0o777;

  for (const umask of [0o000, 0o022, 0o077, 0o277]) {
    test(`created directories are exactly 0700 under umask 0${umask.toString(8)}`, () => {
      process.umask(umask);
      const P = join(scratch, "proj", ".atmux", "tmux", `tmux-${uid}`, "default");
      const created = ensurePrivateSocketDir(P, { uid });
      expect(created).toEqual([join(scratch, "proj", ".atmux", "tmux", `tmux-${uid}`)]);
      expect(modeOf(join(scratch, "proj", ".atmux", "tmux", `tmux-${uid}`))).toBe(0o700);
      // Missing ancestors this call made are exactly 0700 too.
      expect(modeOf(join(scratch, "proj"))).toBe(0o700);
      expect(modeOf(join(scratch, "proj", ".atmux", "tmux"))).toBe(0o700);
      expect(socketPathIssue(P, { uid })).toBeNull();
    });
  }

  test("an existing 0777 directory is refused and left exactly as found", () => {
    const leaf = join(scratch, `tmux-${uid}`);
    mkdirSync(leaf);
    chmodSync(leaf, 0o777);
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid })).toThrow(
      `${leaf} has mode 0777 (group or world bits set) (hint: chmod 700 ${leaf})`,
    );
    expect(modeOf(leaf)).toBe(0o777);
  });

  test("an existing 0755 directory is refused (world-searchable)", () => {
    const leaf = join(scratch, `tmux-${uid}`);
    mkdirSync(leaf, { mode: 0o755 });
    chmodSync(leaf, 0o755);
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid })).toThrow(/has mode 0755/);
  });

  test("a symlink planted where the socket directory goes is refused", () => {
    const target = join(scratch, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const leaf = join(scratch, `tmux-${uid}`);
    symlinkSync(target, leaf);
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid })).toThrow(/is a symlink/);
  });

  test("an existing private directory passes and is reused", () => {
    const leaf = join(scratch, `tmux-${uid}`);
    mkdirSync(leaf, { mode: 0o700 });
    expect(ensurePrivateSocketDir(join(leaf, "default"), { uid })).toEqual([]);
    expect(modeOf(leaf)).toBe(0o700);
  });

  test("a directory owned by a different uid (as seen by the policy) is refused", () => {
    const leaf = join(scratch, `tmux-${uid}`);
    mkdirSync(leaf, { mode: 0o700 });
    // The real directory is ours; claim to be someone else.
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid: uid + 4242 })).toThrow(
      new RegExp(`owned by uid ${uid}, not uid ${uid + 4242}`),
    );
  });
});

// ---------- realSocketDirFs ----------

describe("realSocketDirFs", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-sockdir-fs-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("lstat: ENOENT and ENOTDIR → null; present → stats", () => {
    expect(realSocketDirFs.lstat(join(scratch, "nope"))).toBeNull();
    writeFileSync(join(scratch, "file"), "x");
    expect(realSocketDirFs.lstat(join(scratch, "file", "child"))).toBeNull();
    expect(realSocketDirFs.lstat(scratch)?.isDirectory()).toBe(true);
  });

  test("lstat: any other error propagates", () => {
    // A symlink loop in a NON-final component is ELOOP even under lstat.
    symlinkSync(join(scratch, "loop"), join(scratch, "loop"));
    expect(() => realSocketDirFs.lstat(join(scratch, "loop", "x"))).toThrow();
  });

  test("mkdir: true when created, false on EEXIST, throws otherwise", () => {
    expect(realSocketDirFs.mkdir(join(scratch, "a"), 0o700)).toBe(true);
    expect(realSocketDirFs.mkdir(join(scratch, "a"), 0o700)).toBe(false);
    expect(() => realSocketDirFs.mkdir(join(scratch, "missing", "b"), 0o700)).toThrow();
  });

  test("mkdirp + chmod", () => {
    realSocketDirFs.mkdirp(join(scratch, "p", "q"), 0o700);
    realSocketDirFs.chmod(join(scratch, "p", "q"), 0o700);
    expect(statSync(join(scratch, "p", "q")).mode & 0o777).toBe(0o700);
  });
});

// ---------- resolution with legacy compatibility ----------

describe("resolveCageSocketPath / resolveGroupSocketPath (ADR-305 §D3)", () => {
  const legacyDir = "/tmp/atmux-px";
  const legacy = "/tmp/atmux-px/sock";
  const user = "/tmp/atmux-1000/px/sock";

  test("nothing on disk → per-user path", () => {
    expect(resolveCageSocketPath("px", { uid: A, fs: fakeFs() })).toBe(user);
  });

  test("two uids resolve the same team to different sockets", () => {
    expect(resolveCageSocketPath("px", { uid: A, fs: fakeFs() })).toBe(user);
    expect(resolveCageSocketPath("px", { uid: B, fs: fakeFs() })).toBe("/tmp/atmux-1001/px/sock");
  });

  test("per-user socket present wins over an adoptable legacy one", () => {
    const fs = fakeFs({ [user]: sock(A), [legacyDir]: dir(A), [legacy]: sock(A) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("legacy socket ours in a private (0700) dir → legacy (live cage keeps working)", () => {
    const fs = fakeFs({ [legacyDir]: dir(A), [legacy]: sock(A) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(legacy);
  });

  test("legacy socket ours in a shared (0777) dir → ignored", () => {
    const fs = fakeFs({ [legacyDir]: dir(A, 0o777), [legacy]: sock(A, 0o777) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("root's legacy socket is never another user's default (the coder case)", () => {
    const fs = fakeFs({ [legacyDir]: dir(0, 0o700), [legacy]: sock(0, 0o777) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
    // …while root itself keeps adopting it.
    expect(resolveCageSocketPath("px", { uid: 0, fs })).toBe(legacy);
  });

  test("uninspectable per-user path is not treated as present", () => {
    const fs = fakeFs({}, { throwOn: { [user]: "EACCES" } });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("no POSIX uid → legacy shapes", () => {
    expect(resolveCageSocketPath("px", { uid: null })).toBe(legacy);
    expect(resolveGroupSocketPath("unum", { uid: null })).toBe("/tmp/atmux-grp-unum/sock");
  });

  test("group servers follow the same rules", () => {
    expect(resolveGroupSocketPath("unum", { uid: A, fs: fakeFs() })).toBe(
      "/tmp/atmux-1000/grp-unum/sock",
    );
    expect(resolveGroupSocketPath("unum", { uid: B, fs: fakeFs() })).toBe(
      "/tmp/atmux-1001/grp-unum/sock",
    );
    const adopt = fakeFs({ "/tmp/atmux-grp-unum": dir(A), "/tmp/atmux-grp-unum/sock": sock(A) });
    expect(resolveGroupSocketPath("unum", { uid: A, fs: adopt })).toBe("/tmp/atmux-grp-unum/sock");
    const shared = fakeFs({
      "/tmp/atmux-grp-unum": dir(A, 0o755),
      "/tmp/atmux-grp-unum/sock": sock(A),
    });
    expect(resolveGroupSocketPath("unum", { uid: A, fs: shared })).toBe(
      "/tmp/atmux-1000/grp-unum/sock",
    );
  });

  test("defaults (real uid + real fs) resolve under this process's own root", () => {
    const uid = process.getuid?.() ?? 0;
    const team = `sockdir-none-${process.pid}`;
    expect(resolveCageSocketPath(team)).toBe(`/tmp/atmux-${uid}/${team}/sock`);
    expect(resolveGroupSocketPath(team)).toBe(`/tmp/atmux-${uid}/grp-${team}/sock`);
  });
});

describe("legacySocketState", () => {
  const legacy = "/tmp/atmux-px/sock";
  test.each([
    ["absent", {}, "absent"],
    ["adoptable", { "/tmp/atmux-px": dir(A), [legacy]: sock(A) }, "adoptable"],
    ["shared-dir", { "/tmp/atmux-px": dir(A, 0o777), [legacy]: sock(A) }, "shared-dir"],
    ["foreign owner", { "/tmp/atmux-px": dir(0), [legacy]: sock(0) }, "foreign"],
    [
      "not a socket",
      { "/tmp/atmux-px": dir(A), [legacy]: { kind: "file", uid: A, mode: 0o600 } },
      "foreign",
    ],
  ] as const)("%s", (_label, nodes, want) => {
    expect(legacySocketState(legacy, { uid: A, fs: fakeFs(nodes as Record<string, Node>) })).toBe(
      want,
    );
  });

  test("no POSIX uid + something present → adoptable", () => {
    expect(legacySocketState(legacy, { uid: null, fs: fakeFs({ [legacy]: sock(A) }) })).toBe(
      "adoptable",
    );
  });
});

// ---------- isSocketListening ----------

describe("isSocketListening", () => {
  let scratch: string;
  let server: Server | null = null;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-sockdir-live-"));
  });
  afterEach(async () => {
    if (server !== null) await new Promise<void>((r) => server?.close(() => r()));
    server = null;
    await rm(scratch, { recursive: true, force: true });
  });

  test("a listening unix socket → true", async () => {
    const p = join(scratch, "sock");
    server = createServer();
    await new Promise<void>((r) => server?.listen(p, () => r()));
    expect(await isSocketListening(p)).toBe(true);
  });

  test("absent path / non-socket file → false", async () => {
    expect(await isSocketListening(join(scratch, "nope"))).toBe(false);
    writeFileSync(join(scratch, "file"), "x");
    expect(await isSocketListening(join(scratch, "file"))).toBe(false);
  });

  test("timeout elapses first → false", async () => {
    expect(await isSocketListening(join(scratch, "nope"), 0)).toBe(false);
  });
});

// ---------- settleSocketForCreate ----------

describe("settleSocketForCreate (create-time migration)", () => {
  const legacy = "/tmp/atmux-px/sock";
  const user = "/tmp/atmux-1000/px/sock";

  test("live legacy socket of ours in a SHARED dir → refused with the adopting chmod", async () => {
    const fs = fakeFs({ "/tmp/atmux-px": dir(A, 0o755), [legacy]: sock(A) });
    const p = settleSocketForCreate(user, user, legacy, {
      uid: A,
      fs,
      isListening: async () => true,
    });
    await expect(p).rejects.toBeInstanceOf(ConfigError);
    await expect(
      settleSocketForCreate(user, user, legacy, { uid: A, fs, isListening: async () => true }),
    ).rejects.toThrow("chmod 700 /tmp/atmux-px to keep using that server");
  });

  test("dead legacy socket in a shared dir → ignored, per-user path kept", async () => {
    const fs = fakeFs({ "/tmp/atmux-px": dir(A, 0o777), [legacy]: sock(A) });
    const out = await settleSocketForCreate(user, user, legacy, {
      uid: A,
      fs,
      isListening: async () => false,
      remove: () => {
        throw new Error("must not remove a shared-dir socket");
      },
    });
    expect(out).toBe(user);
  });

  test("live adoptable legacy socket → kept", async () => {
    const fs = fakeFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    const out = await settleSocketForCreate(legacy, user, legacy, {
      uid: A,
      fs,
      isListening: async () => true,
    });
    expect(out).toBe(legacy);
  });

  test("dead adoptable legacy socket → removed, moved to the per-user path", async () => {
    const fs = fakeFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    const removed: string[] = [];
    const logs: string[] = [];
    const out = await settleSocketForCreate(legacy, user, legacy, {
      uid: A,
      fs,
      isListening: async () => false,
      remove: (p) => removed.push(p),
      log: (m) => logs.push(m),
    });
    expect(out).toBe(user);
    expect(removed).toEqual([legacy]);
    expect(logs).toEqual([
      "[atmux] removed dead legacy socket /tmp/atmux-px/sock; moving to /tmp/atmux-1000/px/sock (ADR-305)",
    ]);
  });

  test("removal failure is logged; still moves to the per-user path", async () => {
    const fs = fakeFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    const logs: string[] = [];
    const out = await settleSocketForCreate(legacy, user, legacy, {
      uid: A,
      fs,
      isListening: async () => false,
      remove: () => {
        throw new Error("EPERM");
      },
      log: (m) => logs.push(m),
    });
    expect(out).toBe(user);
    expect(logs[0]).toContain("not removed (Error: EPERM)");
  });

  test("default remover + default logger on a real (absent) path", async () => {
    const team = `sockdir-settle-${process.pid}`;
    const l = `/tmp/atmux-${team}/sock`;
    const u = `/tmp/atmux-${A}/${team}/sock`;
    const fs = fakeFs({ [`/tmp/atmux-${team}`]: dir(A), [l]: sock(A) });
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      // Default isListening dials the (absent) real path → dead; default
      // remover hits ENOENT → logged via the default stderr logger.
      expect(await settleSocketForCreate(l, u, l, { uid: A, fs })).toBe(u);
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.join("")).toContain(`dead legacy socket ${l} not removed`);
  });

  test("adoptable legacy but resolved elsewhere (per-user socket present) → unchanged", async () => {
    const fs = fakeFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    expect(await settleSocketForCreate(user, user, legacy, { uid: A, fs })).toBe(user);
  });

  test("no legacy socket → unchanged", async () => {
    expect(await settleSocketForCreate(user, user, legacy, { uid: A, fs: fakeFs() })).toBe(user);
  });
});
