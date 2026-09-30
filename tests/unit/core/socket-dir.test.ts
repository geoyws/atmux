// ADR-305 — per-user private socket directories (src/core/socket-dir.ts).
//
// Two layers:
//   - a FAKE filesystem (tests/helpers/fake-socket-fs.ts) drives what one
//     uid cannot produce on a real disk (another uid's directory or
//     socket, EACCES, races, symlink chains);
//   - the REAL filesystem (mkdtemp scratch) proves the descriptor walk,
//     the modes (created 0700 under any umask, nothing chmod'ed) and that
//     no descriptor leaks.
// Read bottom-up: every refusal asserts the exact problem + path, so an
// implementation that stopped walking the chain (or started chmod'ing)
// fails here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSocketPathSafe,
  createRealSocketDirFs,
  currentUid,
  ensurePrivateSocketDir,
  isSocketListening,
  legacyCageSocketPath,
  legacyGroupSocketPath,
  legacySocketInfo,
  legacySocketState,
  MAX_SYMLINK_HOPS,
  PRIVATE_DIR_MODE,
  prepareSocketDial,
  privateDirIssue,
  realSocketDirFs,
  resolveCageSocketPath,
  resolveGroupSocketPath,
  SOCKET_BASE_DIR,
  SOCKET_DIR_FEATURE,
  SOCKET_DIR_FEATURE_NAME,
  SOCKET_DIR_REVISION,
  settleSocketForCreate,
  socketPathIssue,
  UnsafeSocketPathError,
  userCageSocketPath,
  userGroupSocketPath,
  userSocketRoot,
} from "../../../src/core/socket-dir.ts";
import { ConfigError } from "../../../src/errors.ts";
import {
  dir,
  type FakeNode,
  fakeSocketFs,
  file,
  link,
  sock,
} from "../../helpers/fake-socket-fs.ts";

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
    expect(userGroupSocketPath("unum", 0)).toBe("/tmp/atmux-0/grp-unum/sock");
    expect(userGroupSocketPath("unum", A)).toBe("/tmp/atmux-1000/grp-unum/sock");
  });

  test("pre-ADR-305 legacy shapes are unchanged", () => {
    expect(legacyCageSocketPath("px")).toBe("/tmp/atmux-px/sock");
    expect(legacyGroupSocketPath("unum")).toBe("/tmp/atmux-grp-unum/sock");
  });

  test("currentUid reports the process uid", () => {
    expect(currentUid()).toBe(process.getuid?.() ?? null);
  });

  test("stable capability marker", () => {
    // The scheme name is stable; `;rev=3` lets a consumer refuse the
    // unreleased first two cuts (35ea2c3, a9f96ac2), which printed the
    // bare name.
    expect(SOCKET_DIR_FEATURE).toBe("socket-dirs=per-user-0700;rev=3");
    expect(SOCKET_DIR_FEATURE_NAME).toBe("socket-dirs=per-user-0700");
    expect(SOCKET_DIR_REVISION).toBe(3);
  });
});

// ---------- socketPathIssue: the whole-chain rule (inspect) ----------

describe("socketPathIssue — the socket's own directory and node", () => {
  const S = "/tmp/atmux-1000/px/sock";

  test("absent per-user root → no issue, and INSPECT creates nothing", () => {
    const fs = fakeSocketFs();
    expect(socketPathIssue(S, { uid: A, fs })).toBeNull();
    expect(fs.calls.some((c) => c.startsWith("mkdir"))).toBe(false);
    expect(fs.openHandles()).toBe(0);
  });

  test("private chain + own socket → safe", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: sock(A),
    });
    expect(socketPathIssue(S, { uid: A, fs })).toBeNull();
    expect(fs.calls.filter((c) => c.startsWith("open"))).toEqual([
      "open /",
      "open /tmp",
      "open /tmp/atmux-1000",
      "open /tmp/atmux-1000/px",
    ]);
    expect(fs.openHandles()).toBe(0);
  });

  test("per-user root squatted by another uid → foreign-owner", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(B, 0o777) });
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue).toMatchObject({
      problem: "foreign-owner",
      path: "/tmp/atmux-1000",
      detail: "is owned by uid 1001, not uid 1000",
    });
    expect(issue?.hint).toContain("never uses another user's socket directory");
  });

  for (const mode of [0o777, 0o755, 0o750, 0o710, 0o701, 0o770, 0o707]) {
    test(`leaf mode 0${mode.toString(8)} (group/world rwx or search) → shared-mode`, () => {
      const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A, mode) });
      expect(socketPathIssue(S, { uid: A, fs })).toEqual({
        path: "/tmp/atmux-1000/px",
        problem: "shared-mode",
        detail: `has mode 0${mode.toString(8)} (group or world bits set)`,
        hint: "chmod 700 /tmp/atmux-1000/px",
      });
    });
  }

  test("owner-only narrower modes (0500) are private", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A, 0o500), "/tmp/atmux-1000/px": dir(A) });
    expect(socketPathIssue(S, { uid: A, fs })).toBeNull();
  });

  test("leaf is a symlink (even a trusted one) → refused: the socket's own dir is never followed", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": link("/tmp/atmux-1000/elsewhere", A),
      "/tmp/atmux-1000/elsewhere": dir(A),
    });
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue).toMatchObject({ problem: "symlink", path: "/tmp/atmux-1000/px" });
    expect(issue?.hint).toContain("replace /tmp/atmux-1000/px with a real directory");
  });

  test("leaf is a regular file → not-directory", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": file(A) });
    expect(socketPathIssue(S, { uid: A, fs })).toMatchObject({
      problem: "not-directory",
      path: "/tmp/atmux-1000/px",
      hint: "remove it (rm /tmp/atmux-1000/px); atmux recreates the directory 0700",
    });
  });

  test("open EACCES → uninspectable, naming the directory", () => {
    const fs = fakeSocketFs(
      { "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A) },
      { openThrows: { "/tmp/atmux-1000/px": "EACCES" } },
    );
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue).toMatchObject({ problem: "uninspectable", path: "/tmp/atmux-1000/px" });
    expect(issue?.detail).toBe("cannot be opened (EACCES)");
  });

  test("EACCES on another uid's private directory → named as foreign-owner (from its lstat)", () => {
    const fs = fakeSocketFs(
      { "/tmp/atmux-1000": dir(B, 0o700) },
      { openThrows: { "/tmp/atmux-1000": "EACCES" } },
    );
    expect(socketPathIssue(S, { uid: A, fs })).toMatchObject({
      problem: "foreign-owner",
      path: "/tmp/atmux-1000",
      detail: "is owned by uid 1001, not uid 1000",
    });
  });

  test("EACCES on something that is not a directory → uninspectable", () => {
    const fs = fakeSocketFs(
      { "/tmp/atmux-1000": file(A) },
      { openThrows: { "/tmp/atmux-1000": "EACCES" } },
    );
    expect(socketPathIssue(S, { uid: A, fs })?.problem).toBe("uninspectable");
  });

  test("ELOOP on an entry that is still a directory → uninspectable (never assumed safe)", () => {
    const fs = fakeSocketFs(
      { "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A) },
      { openThrows: { "/tmp/atmux-1000/px": "ELOOP" } },
    );
    expect(socketPathIssue(S, { uid: A, fs })).toMatchObject({
      problem: "uninspectable",
      detail: "cannot be opened (ELOOP)",
    });
  });

  test("ENOTDIR on an entry that vanished before classification → uninspectable", () => {
    const fs = fakeSocketFs(
      { "/tmp/atmux-1000": dir(A) },
      { openThrows: { "/tmp/atmux-1000/px": "ENOTDIR" } },
    );
    expect(socketPathIssue(S, { uid: A, fs })?.problem).toBe("uninspectable");
  });

  test("a failure without an errno code still refuses, and closes every handle", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A) });
    fs.fstat = () => {
      throw "boom";
    };
    expect(socketPathIssue(S, { uid: A, fs })).toMatchObject({
      problem: "uninspectable",
      path: S,
      detail: "cannot be opened (boom)",
    });
    expect(fs.openHandles()).toBe(0);
  });

  test("openRoot failing → uninspectable on the socket path", () => {
    const fs = fakeSocketFs({}, { rootThrows: "EMFILE" });
    expect(socketPathIssue(S, { uid: A, fs })).toMatchObject({
      problem: "uninspectable",
      path: S,
      detail: "cannot be opened (EMFILE)",
    });
  });

  test("planted socket owned by another uid inside a private dir → foreign-owner", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: sock(0),
    });
    const issue = socketPathIssue(S, { uid: A, fs });
    expect(issue).toMatchObject({ problem: "foreign-owner", path: S });
    expect(issue?.hint).toContain("never connects to another user's tmux server");
  });

  test("socket node is a symlink → refused", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: link("/tmp/other/sock", A),
    });
    expect(socketPathIssue(S, { uid: A, fs })).toMatchObject({
      problem: "symlink",
      path: S,
      hint: `remove it (rm ${S})`,
    });
  });

  test("no POSIX uid → checks off", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(B, 0o777) });
    expect(socketPathIssue(S, { uid: null, fs })).toBeNull();
    expect(fs.calls).toEqual([]);
  });
});

describe("socketPathIssue — every ancestor from / down (review of 35ea2c3, item 1)", () => {
  const T = "/tmp/atmux-tmux_rv/tmux-1000/default";

  test("reviewer case: tmuxTmpdir /tmp/atmux-tmux_rv pre-planted by another uid (0777) → refused at the PARENT", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-tmux_rv": dir(B, 0o777),
      "/tmp/atmux-tmux_rv/tmux-1000": dir(A),
    });
    expect(socketPathIssue(T, { uid: A, fs })).toMatchObject({
      problem: "foreign-owner",
      path: "/tmp/atmux-tmux_rv",
      detail: "is owned by uid 1001, not uid 1000",
    });
  });

  test("/tmp/atmux-* must be ours AND 0700: our own 0755 /tmp/atmux-tmux_rv is refused", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-tmux_rv": dir(A, 0o755),
      "/tmp/atmux-tmux_rv/tmux-1000": dir(A),
    });
    expect(socketPathIssue(T, { uid: A, fs })).toMatchObject({
      problem: "shared-mode",
      path: "/tmp/atmux-tmux_rv",
      hint: "chmod 700 /tmp/atmux-tmux_rv",
    });
  });

  test("root-owned /tmp/atmux-tmux_rv is refused for a non-root uid (not ours)", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-tmux_rv": dir(0, 0o700) });
    expect(socketPathIssue(T, { uid: A, fs })?.problem).toBe("foreign-owner");
  });

  test("ours and 0700 → safe", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-tmux_rv": dir(A),
      "/tmp/atmux-tmux_rv/tmux-1000": dir(A),
    });
    expect(socketPathIssue(T, { uid: A, fs })).toBeNull();
  });

  test("a non-atmux ancestor may be root- or uid-owned and 0755 (not writable by others)", () => {
    const P = "/srv/proj/.atmux/tmux/tmux-1000/default";
    const fs = fakeSocketFs({
      "/srv": dir(0, 0o755),
      "/srv/proj": dir(A, 0o755),
      "/srv/proj/.atmux": dir(A, 0o755),
      "/srv/proj/.atmux/tmux": dir(A, 0o755),
      "/srv/proj/.atmux/tmux/tmux-1000": dir(A),
    });
    expect(socketPathIssue(P, { uid: A, fs })).toBeNull();
  });

  test("an ancestor owned by another uid → foreign-owner (neither root nor us)", () => {
    const P = "/srv/proj/.atmux/tmux/tmux-1000/default";
    const fs = fakeSocketFs({ "/srv": dir(0, 0o755), "/srv/proj": dir(B, 0o755) });
    expect(socketPathIssue(P, { uid: A, fs })).toMatchObject({
      problem: "foreign-owner",
      path: "/srv/proj",
      detail: "is owned by uid 1001 (neither root nor uid 1000)",
    });
  });

  for (const [label, node] of [
    ["root-owned 0777, no sticky bit", dir(0, 0o777)],
    ["root-owned 0775 (group-writable)", dir(0, 0o775)],
    ["root-owned 0757 (world-writable)", dir(0, 0o757)],
    ["our own 1777 (sticky, but not root's)", dir(A, 0o1777)],
  ] as const) {
    test(`an ancestor that is ${label} → shared-mode`, () => {
      const P = "/srv/proj/tmux-1000/default";
      const fs = fakeSocketFs({ "/srv": dir(0, 0o755), "/srv/proj": node });
      const issue = socketPathIssue(P, { uid: A, fs });
      expect(issue).toMatchObject({ problem: "shared-mode", path: "/srv/proj" });
      expect(issue?.detail).toContain(
        "writable by group or other, and not a root-owned sticky directory",
      );
    });
  }

  test("/tmp itself 0777 without the sticky bit (@@hax until 2026-09-30) → refused at /tmp", () => {
    const fs = fakeSocketFs({ "/tmp": dir(0, 0o777), "/tmp/atmux-1000": dir(A) });
    expect(socketPathIssue("/tmp/atmux-1000/px/sock", { uid: A, fs })).toMatchObject({
      problem: "shared-mode",
      path: "/tmp",
      detail: "has mode 0777 (writable by group or other, and not a root-owned sticky directory)",
    });
  });

  test("/ itself must be trusted", () => {
    const fs = fakeSocketFs({ "/": dir(B, 0o755) });
    expect(socketPathIssue("/tmp/atmux-1000/px/sock", { uid: A, fs })).toMatchObject({
      problem: "foreign-owner",
      path: "/",
    });
  });

  test("a socket directly under / makes / its private directory", () => {
    expect(socketPathIssue("/sock", { uid: A, fs: fakeSocketFs() })).toMatchObject({
      problem: "foreign-owner",
      path: "/",
    });
    expect(socketPathIssue("/sock", { uid: 0, fs: fakeSocketFs() })).toMatchObject({
      problem: "shared-mode",
      path: "/",
    });
  });

  test("an ancestor another uid planted as a symlink inside sticky /tmp → refused, never followed", () => {
    const fs = fakeSocketFs({
      "/tmp/proj": link("/srv/proj", B),
      "/srv": dir(0, 0o755),
      "/srv/proj": dir(A, 0o755),
    });
    const issue = socketPathIssue("/tmp/proj/tmux-1000/default", { uid: A, fs });
    expect(issue).toMatchObject({ problem: "symlink", path: "/tmp/proj", detail: "is a symlink" });
    expect(fs.calls).not.toContain("open /srv");
  });

  test("even a root-owned symlink inside a shared sticky directory is refused", () => {
    const fs = fakeSocketFs({ "/tmp/proj": link("/srv/proj", 0) });
    expect(socketPathIssue("/tmp/proj/tmux-1000/default", { uid: A, fs })?.problem).toBe("symlink");
  });

  test("a symlink owned by another uid in a trusted directory → refused", () => {
    const fs = fakeSocketFs({ "/srv": dir(0, 0o755), "/srv/proj": link("/opt/proj", B) });
    expect(socketPathIssue("/srv/proj/tmux-1000/default", { uid: A, fs })).toMatchObject({
      problem: "symlink",
      path: "/srv/proj",
    });
  });

  test("macOS shape: /tmp → private/tmp (root's link in root's /) is followed and checked physically", () => {
    const fs = fakeSocketFs({
      "/tmp": link("private/tmp", 0),
      "/private": dir(0, 0o755),
      "/private/tmp": dir(0, 0o1777),
      "/private/tmp/atmux-1000": dir(A),
      "/private/tmp/atmux-1000/px": dir(A),
      "/private/tmp/atmux-1000/px/sock": sock(A),
    });
    expect(socketPathIssue("/tmp/atmux-1000/px/sock", { uid: A, fs })).toBeNull();
    // The rule applies on the physical side: /private/tmp is shared, so
    // its atmux-* entry must be ours.
    fs.nodes.set("/private/tmp/atmux-1000", dir(B, 0o700));
    expect(socketPathIssue("/tmp/atmux-1000/px/sock", { uid: A, fs })).toMatchObject({
      problem: "foreign-owner",
      path: "/private/tmp/atmux-1000",
    });
    expect(fs.openHandles()).toBe(0);
  });

  test("an absolute trusted link restarts at /; '..' and '.' in a target resolve physically", () => {
    const fs = fakeSocketFs({
      "/var": dir(0, 0o755),
      "/var/run": link("../run", 0),
      "/run": dir(0, 0o755),
      "/run/user": link("/srv/./user", 0),
      "/srv": dir(0, 0o755),
      "/srv/user": dir(A, 0o755),
      "/srv/user/x": dir(A),
      "/srv/user/x/sock": sock(A),
    });
    expect(socketPathIssue("/var/run/user/x/sock", { uid: A, fs })).toBeNull();
    expect(fs.calls.filter((c) => c.startsWith("open"))).toEqual([
      "open /",
      "open /var",
      "open /var/run",
      "open /run",
      "open /run/user",
      "open /srv",
      "open /srv/user",
      "open /srv/user/x",
    ]);
    expect(fs.openHandles()).toBe(0);
  });

  test("'..' at / stays at /", () => {
    const fs = fakeSocketFs({ "/l": link("../../srv", 0), "/srv": dir(A, 0o700) });
    expect(socketPathIssue("/l/sock", { uid: A, fs })).toMatchObject({
      problem: "symlink",
      path: "/l",
    });
    expect(socketPathIssue("/l/x/sock", { uid: A, fs })).toBeNull();
  });

  test(`a symlink loop stops after ${MAX_SYMLINK_HOPS} hops`, () => {
    const fs = fakeSocketFs({ "/srv": dir(0, 0o755), "/srv/a": link("b"), "/srv/b": link("a") });
    expect(socketPathIssue("/srv/a/x/sock", { uid: A, fs })).toMatchObject({
      problem: "symlink",
      detail: `is a symlink chain longer than ${MAX_SYMLINK_HOPS} hops`,
    });
  });

  for (const bad of ["/tmp/../etc/sock", "/tmp/./x/sock", "/tmp/x/..", "/tmp/x/.", ""]) {
    test(`not-normalized socket path ${JSON.stringify(bad)} is refused`, () => {
      expect(socketPathIssue(bad, { uid: A, fs: fakeSocketFs() })).toMatchObject({
        problem: "not-normalized",
        path: bad,
      });
    });
  }

  test("a relative socket path is walked from the cwd", () => {
    const fs = fakeSocketFs();
    expect(socketPathIssue("rel/sock", { uid: A, fs })).toBeNull();
    const first = process.cwd().split("/").filter(Boolean)[0];
    expect(fs.calls).toContain(`open /${first}`);
  });
});

// ---------- privateDirIssue (test-reaper's removal gate) ----------

describe("privateDirIssue — a directory that is ours alone", () => {
  test("ours, 0700, passing chain → null; nothing created", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-cockpit-a-b": dir(A) });
    expect(privateDirIssue("/tmp/atmux-cockpit-a-b", { uid: A, fs })).toBeNull();
    expect(fs.calls.some((c) => c.startsWith("mkdir"))).toBe(false);
    expect(fs.openHandles()).toBe(0);
  });

  test("another uid's directory → foreign-owner", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-cockpit-a-b": dir(B, 0o777) });
    expect(privateDirIssue("/tmp/atmux-cockpit-a-b", { uid: 0, fs })).toMatchObject({
      problem: "foreign-owner",
      path: "/tmp/atmux-cockpit-a-b",
    });
  });

  test("ours but shared (0755) → shared-mode", () => {
    const fs = fakeSocketFs({ "/srv": dir(0, 0o755), "/srv/x": dir(A, 0o755) });
    expect(privateDirIssue("/srv/x", { uid: A, fs })?.problem).toBe("shared-mode");
  });

  test("a symlink where the directory should be → refused, never followed", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-cockpit-a-b": link("/srv/x", A), "/srv": dir(0, 0o755) });
    expect(privateDirIssue("/tmp/atmux-cockpit-a-b", { uid: A, fs })?.problem).toBe("symlink");
  });

  test("missing → a refusal naming it", () => {
    expect(privateDirIssue("/tmp/atmux-gone", { uid: A, fs: fakeSocketFs() })).toMatchObject({
      problem: "uninspectable",
      path: "/tmp/atmux-gone",
      detail: "does not exist",
    });
  });

  test("not normalized → refused with the directory as its path", () => {
    expect(privateDirIssue("/tmp/../etc", { uid: A, fs: fakeSocketFs() })).toMatchObject({
      problem: "not-normalized",
      path: "/tmp/../etc",
    });
  });

  test("no POSIX uid → checks off", () => {
    expect(privateDirIssue("/anything", { uid: null, fs: fakeSocketFs() })).toBeNull();
  });
});

// ---------- prepareSocketDial / assertSocketPathSafe (connect) ----------

describe("prepareSocketDial — connect-time (review item 4: absent is not 'safe')", () => {
  const S = "/tmp/atmux-1000/px/sock";

  test("missing /tmp/atmux-<uid> is created 0700 BEFORE the dial, so nobody can plant it", () => {
    const fs = fakeSocketFs({}, { creatorUid: A });
    expect(prepareSocketDial(S, { uid: A, fs })).toBe(false);
    expect(fs.nodes.get("/tmp/atmux-1000")).toEqual(dir(A, 0o700));
    // Below a private directory nothing is created: nobody else can.
    expect(fs.nodes.has("/tmp/atmux-1000/px")).toBe(false);
    expect(fs.calls.filter((c) => c.startsWith("mkdir"))).toEqual(["mkdir /tmp/atmux-1000"]);
    expect(fs.openHandles()).toBe(0);
  });

  test("a squattable non-atmux entry of /tmp (TMUX_TMPDIR) is created too", () => {
    const fs = fakeSocketFs({}, { creatorUid: A });
    expect(prepareSocketDial("/tmp/gate/tmux-1000/default", { uid: A, fs })).toBe(false);
    expect(fs.nodes.get("/tmp/gate")).toEqual(dir(A, 0o700));
  });

  test("missing below a trusted non-shared parent → not created, not dialled", () => {
    const fs = fakeSocketFs({ "/srv": dir(0, 0o755) });
    expect(prepareSocketDial("/srv/p/tmux-1000/default", { uid: A, fs })).toBe(false);
    expect(fs.calls.some((c) => c.startsWith("mkdir"))).toBe(false);
  });

  test("our socket in a passing chain → true (dial it)", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: sock(A),
    });
    expect(prepareSocketDial(S, { uid: A, fs })).toBe(true);
  });

  test("a non-socket node of ours → false (nothing to dial)", () => {
    const fs = fakeSocketFs({
      "/tmp/atmux-1000": dir(A),
      "/tmp/atmux-1000/px": dir(A),
      [S]: file(A),
    });
    expect(prepareSocketDial(S, { uid: A, fs })).toBe(false);
  });

  test("a squatted per-user root → throws (never dialled)", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(B, 0o700) });
    expect(() => prepareSocketDial(S, { uid: A, fs })).toThrow(UnsafeSocketPathError);
  });

  test("losing the mkdir race to another uid → throws", () => {
    const fs = fakeSocketFs({}, { raceOn: { "/tmp/atmux-1000": dir(B, 0o700) } });
    expect(() => prepareSocketDial(S, { uid: A, fs })).toThrow(/owned by uid 1001/);
  });

  test("no POSIX uid → just 'is a socket there'", () => {
    expect(prepareSocketDial(S, { uid: null, fs: fakeSocketFs({ [S]: sock(A) }) })).toBe(true);
    expect(prepareSocketDial(S, { uid: null, fs: fakeSocketFs() })).toBe(false);
  });

  test("assertSocketPathSafe throws UnsafeSocketPathError (a ConfigError) carrying the issue", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A, 0o777) });
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
    expect(() =>
      assertSocketPathSafe(S, { uid: A, fs: fakeSocketFs({}, { creatorUid: A }) }),
    ).not.toThrow();
  });
});

// ---------- ensurePrivateSocketDir (fake fs) ----------

describe("ensurePrivateSocketDir — create (fake fs)", () => {
  const S = "/tmp/atmux-1000/px/sock";

  test("creates root + leaf 0700 through the parent handle; the seam has no chmod at all", () => {
    const fs = fakeSocketFs({}, { creatorUid: A });
    expect(ensurePrivateSocketDir(S, { uid: A, fs })).toEqual([
      "/tmp/atmux-1000",
      "/tmp/atmux-1000/px",
    ]);
    expect(fs.nodes.get("/tmp/atmux-1000")?.mode).toBe(PRIVATE_DIR_MODE);
    expect(fs.nodes.get("/tmp/atmux-1000/px")?.mode).toBe(PRIVATE_DIR_MODE);
    expect("chmod" in fs).toBe(false);
    expect(fs.openHandles()).toBe(0);
  });

  test("existing private root is reused", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A) }, { creatorUid: A });
    expect(ensurePrivateSocketDir(S, { uid: A, fs })).toEqual(["/tmp/atmux-1000/px"]);
  });

  test("existing wide root is refused and left as found", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(A, 0o777) }, { creatorUid: A });
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(UnsafeSocketPathError);
    expect(fs.nodes.get("/tmp/atmux-1000")?.mode).toBe(0o777);
    expect(fs.nodes.has("/tmp/atmux-1000/px")).toBe(false);
  });

  test("root squatted by another uid → refused before any team dir is made", () => {
    const fs = fakeSocketFs({ "/tmp/atmux-1000": dir(B, 0o700) }, { creatorUid: A });
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      /owned by uid 1001, not uid 1000/,
    );
    expect(fs.nodes.has("/tmp/atmux-1000/px")).toBe(false);
  });

  test("race: mkdir hits EEXIST on a directory another uid just planted → refused", () => {
    const fs = fakeSocketFs({}, { creatorUid: A, raceOn: { "/tmp/atmux-1000": dir(B, 0o777) } });
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(/owned by uid 1001/);
  });

  test("race: EEXIST on a symlink another uid planted → refused, never followed", () => {
    const fs = fakeSocketFs(
      {},
      { creatorUid: A, raceOn: { "/tmp/atmux-1000": link("/tmp/evil", B) } },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(/is a symlink/);
  });

  test("directory vanishing right after creation is refused, not assumed", () => {
    const fs = fakeSocketFs(
      {},
      { creatorUid: A, afterCreateOpenThrows: { "/tmp/atmux-1000": "ENOENT" } },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      /vanished right after it was created/,
    );
  });

  test("mkdir failing (EACCES) → uninspectable 'cannot be created'", () => {
    const fs = fakeSocketFs({}, { mkdirThrows: { "/tmp/atmux-1000": "EACCES" } });
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      "/tmp/atmux-1000 cannot be created (EACCES)",
    );
  });

  test("re-open after creation failing (EACCES) → refused", () => {
    const fs = fakeSocketFs(
      {},
      { creatorUid: A, afterCreateOpenThrows: { "/tmp/atmux-1000/px": "EACCES" } },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      "/tmp/atmux-1000/px cannot be opened (EACCES)",
    );
  });

  test("a planted foreign socket in the (private) leaf is refused after the dirs pass", () => {
    const fs = fakeSocketFs(
      { "/tmp/atmux-1000": dir(A), "/tmp/atmux-1000/px": dir(A), [S]: sock(B) },
      { creatorUid: A },
    );
    expect(() => ensurePrivateSocketDir(S, { uid: A, fs })).toThrow(
      /px\/sock is owned by uid 1001/,
    );
  });

  test("missing tmuxTmpdir ancestors are created top-down, each 0700", () => {
    const P = "/r/.atmux/tmux/tmux-1000/default";
    const fs = fakeSocketFs({ "/r": dir(A, 0o755) }, { creatorUid: A });
    expect(ensurePrivateSocketDir(P, { uid: A, fs })).toEqual([
      "/r/.atmux",
      "/r/.atmux/tmux",
      "/r/.atmux/tmux/tmux-1000",
    ]);
    expect(fs.calls.filter((c) => c.startsWith("mkdir"))).toEqual([
      "mkdir /r/.atmux",
      "mkdir /r/.atmux/tmux",
      "mkdir /r/.atmux/tmux/tmux-1000",
    ]);
    for (const d of ["/r/.atmux", "/r/.atmux/tmux", "/r/.atmux/tmux/tmux-1000"]) {
      expect(fs.nodes.get(d)).toEqual(dir(A, 0o700));
    }
    // The existing ancestor is untouched.
    expect(fs.nodes.get("/r")).toEqual(dir(A, 0o755));
  });

  test("an ancestor another uid wins the mkdir race for (EEXIST, 1777) → refused", () => {
    const P = "/r/.atmux/tmux/tmux-1000/default";
    const fs = fakeSocketFs(
      { "/r": dir(A, 0o755) },
      { creatorUid: A, raceOn: { "/r/.atmux": dir(B, 0o1777) } },
    );
    expect(() => ensurePrivateSocketDir(P, { uid: A, fs })).toThrow(
      "/r/.atmux is owned by uid 1001 (neither root nor uid 1000)",
    );
  });

  test("reviewer case: pre-planted /tmp/atmux-tmux_rv (another uid, 0777) → refused, nothing created inside", () => {
    const P = "/tmp/atmux-tmux_rv/tmux-0/default";
    const fs = fakeSocketFs({ "/tmp/atmux-tmux_rv": dir(B, 0o777) }, { creatorUid: 0 });
    expect(() => ensurePrivateSocketDir(P, { uid: 0, fs })).toThrow(
      "/tmp/atmux-tmux_rv is owned by uid 1001, not uid 0",
    );
    expect(fs.nodes.has("/tmp/atmux-tmux_rv/tmux-0")).toBe(false);
  });

  test("no POSIX uid → plain mkdir -p 0700 of the socket's directory", () => {
    const fs = fakeSocketFs();
    expect(ensurePrivateSocketDir("/x/y/sock", { uid: null, fs })).toEqual([]);
    expect(fs.calls).toEqual(["mkdirp /x/y 700"]);
  });
});

// ---------- real filesystem: the descriptor walk ----------

describe("real filesystem — descriptor walk, modes, no chmod, no leaks", () => {
  let scratch: string;
  const uid = process.getuid?.() ?? 0;
  let savedUmask: number;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "sockdir-real-"));
    savedUmask = process.umask();
  });
  afterEach(async () => {
    process.umask(savedUmask);
    await rm(scratch, { recursive: true, force: true });
  });

  const modeOf = (p: string): number => statSync(p).mode & 0o7777;

  for (const umask of [0o000, 0o022, 0o077, 0o277]) {
    test(`created directories are exactly 0700 under umask 0${umask.toString(8)}, umask restored`, () => {
      process.umask(umask);
      const P = join(scratch, "proj", ".atmux", "tmux", `tmux-${uid}`, "default");
      expect(ensurePrivateSocketDir(P, { uid })).toEqual([
        join(scratch, "proj"),
        join(scratch, "proj", ".atmux"),
        join(scratch, "proj", ".atmux", "tmux"),
        join(scratch, "proj", ".atmux", "tmux", `tmux-${uid}`),
      ]);
      for (const d of ["proj", "proj/.atmux", "proj/.atmux/tmux", `proj/.atmux/tmux/tmux-${uid}`]) {
        expect(modeOf(join(scratch, d))).toBe(0o700);
      }
      expect(process.umask()).toBe(umask);
      expect(socketPathIssue(P, { uid })).toBeNull();
    });
  }

  test("both resolvers (/proc/self/fd openat and the path fallback) agree", () => {
    const P = join(scratch, `tmux-${uid}`, "default");
    for (const procFd of [true, false]) {
      const fs = createRealSocketDirFs({ procFd });
      expect(socketPathIssue(P, { uid, fs })).toBeNull();
      expect(prepareSocketDial(P, { uid, fs })).toBe(false);
    }
    const viaPath = createRealSocketDirFs({ procFd: false });
    expect(ensurePrivateSocketDir(P, { uid, fs: viaPath })).toEqual([join(scratch, `tmux-${uid}`)]);
    chmodSync(join(scratch, `tmux-${uid}`), 0o755);
    for (const procFd of [true, false]) {
      expect(socketPathIssue(P, { uid, fs: createRealSocketDirFs({ procFd }) })?.problem).toBe(
        "shared-mode",
      );
    }
  });

  test("an existing 0777 socket directory is refused and left exactly as found", () => {
    const leaf = join(scratch, `tmux-${uid}`);
    mkdirSync(leaf);
    chmodSync(leaf, 0o777);
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid })).toThrow(
      `${leaf} has mode 0777 (group or world bits set) (hint: chmod 700 ${leaf})`,
    );
    expect(modeOf(leaf)).toBe(0o777);
  });

  test("a world-writable, non-sticky ANCESTOR is refused (another uid could rename below it)", () => {
    const open = join(scratch, "open");
    mkdirSync(join(open, `tmux-${uid}`), { recursive: true, mode: 0o700 });
    chmodSync(open, 0o777);
    const issue = socketPathIssue(join(open, `tmux-${uid}`, "default"), { uid });
    expect(issue).toMatchObject({ problem: "shared-mode", path: open });
  });

  test("a symlink planted where the socket directory goes is refused", () => {
    const target = join(scratch, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    const leaf = join(scratch, `tmux-${uid}`);
    symlinkSync(target, leaf);
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid })).toThrow(/is a symlink/);
  });

  test("a trusted symlinked ancestor (ours, in our private dir) is followed", () => {
    const real = join(scratch, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(scratch, "via"));
    const P = join(scratch, "via", `tmux-${uid}`, "default");
    expect(ensurePrivateSocketDir(P, { uid })).toEqual([join(real, `tmux-${uid}`)]);
    expect(modeOf(join(real, `tmux-${uid}`))).toBe(0o700);
  });

  test("a non-directory in the chain is refused", () => {
    writeFileSync(join(scratch, "f"), "x");
    expect(socketPathIssue(join(scratch, "f", `tmux-${uid}`, "default"), { uid })).toMatchObject({
      problem: "not-directory",
    });
  });

  test("a directory owned by a different uid (as seen by the policy) is refused", () => {
    const leaf = join(scratch, `tmux-${uid}`);
    mkdirSync(leaf, { mode: 0o700 });
    expect(() => ensurePrivateSocketDir(join(leaf, "default"), { uid: uid + 4242 })).toThrow(
      new RegExp(`owned by uid ${uid}`),
    );
  });

  test.skipIf(process.platform !== "linux")("no descriptor leaks across 200 walks", () => {
    const P = join(scratch, `tmux-${uid}`, "default");
    ensurePrivateSocketDir(P, { uid });
    const before = readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 100; i++) {
      socketPathIssue(P, { uid });
      socketPathIssue(join(scratch, "missing", "x", "sock"), { uid });
    }
    expect(readdirSync("/proc/self/fd").length).toBe(before);
  });
});

describe("realSocketDirFs primitives", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "sockdir-fs-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("lstat: ENOENT and ENOTDIR → null; present → stats; other errors propagate", () => {
    expect(realSocketDirFs.lstat(join(scratch, "nope"))).toBeNull();
    writeFileSync(join(scratch, "file"), "x");
    expect(realSocketDirFs.lstat(join(scratch, "file", "child"))).toBeNull();
    expect(realSocketDirFs.lstat(scratch)?.isDirectory()).toBe(true);
    symlinkSync(join(scratch, "loop"), join(scratch, "loop"));
    expect(() => realSocketDirFs.lstat(join(scratch, "loop", "x"))).toThrow();
  });

  test("mkdirAt: true when created, false on EEXIST, throws otherwise; readlinkAt reads a link", () => {
    for (const procFd of [true, false]) {
      const fs = createRealSocketDirFs({ procFd });
      const root = fs.openRoot();
      const parent = { path: scratch, fd: -1 };
      const opened = procFd ? { path: scratch, fd: openScratch(fs, scratch) } : parent;
      const sub = `a-${procFd}`;
      expect(fs.mkdirAt(opened, sub)).toBe(true);
      expect(fs.mkdirAt(opened, sub)).toBe(false);
      expect(() => fs.mkdirAt(opened, `missing-${procFd}/b`)).toThrow();
      symlinkSync("target", join(scratch, `l-${procFd}`));
      expect(fs.readlinkAt(opened, `l-${procFd}`)).toBe("target");
      if (procFd) fs.close(opened);
      fs.close(root);
    }
  });

  test("mkdirp creates the whole path", () => {
    realSocketDirFs.mkdirp(join(scratch, "p", "q"), 0o700);
    expect(statSync(join(scratch, "p", "q")).isDirectory()).toBe(true);
  });
});

/** Open `path` by walking from / with the real seam (a held handle). */
function openScratch(fs: ReturnType<typeof createRealSocketDirFs>, path: string): number {
  let h = fs.openRoot();
  for (const name of path.split("/").filter(Boolean)) {
    const next = fs.openDirAt(h, name);
    fs.close(h);
    h = next;
  }
  return h.fd;
}

// ---------- resolution with legacy compatibility ----------

describe("resolveCageSocketPath / resolveGroupSocketPath (ADR-305 §D3)", () => {
  const legacyDir = "/tmp/atmux-px";
  const legacy = "/tmp/atmux-px/sock";
  const user = "/tmp/atmux-1000/px/sock";

  test("nothing on disk → per-user path", () => {
    expect(resolveCageSocketPath("px", { uid: A, fs: fakeSocketFs() })).toBe(user);
  });

  test("two uids resolve the same team to different sockets", () => {
    expect(resolveCageSocketPath("px", { uid: A, fs: fakeSocketFs() })).toBe(user);
    expect(resolveCageSocketPath("px", { uid: B, fs: fakeSocketFs() })).toBe(
      "/tmp/atmux-1001/px/sock",
    );
  });

  test("per-user socket present wins over an adoptable legacy one", () => {
    const fs = fakeSocketFs({ [user]: sock(A), [legacyDir]: dir(A), [legacy]: sock(A) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("legacy socket ours in a private (0700) dir → legacy (live cage keeps working)", () => {
    const fs = fakeSocketFs({ [legacyDir]: dir(A), [legacy]: sock(A) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(legacy);
  });

  test("legacy socket ours in a shared (0777) dir → ignored", () => {
    const fs = fakeSocketFs({ [legacyDir]: dir(A, 0o777), [legacy]: sock(A, 0o777) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("legacy socket ours, private dir, but /tmp not sticky → ignored (whole chain)", () => {
    const fs = fakeSocketFs({ "/tmp": dir(0, 0o777), [legacyDir]: dir(A), [legacy]: sock(A) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("root's legacy socket is never another user's default (the coder case)", () => {
    const fs = fakeSocketFs({ [legacyDir]: dir(0, 0o700), [legacy]: sock(0, 0o777) });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
    // …while root itself keeps adopting it.
    expect(resolveCageSocketPath("px", { uid: 0, fs })).toBe(legacy);
  });

  test("uninspectable per-user path is not treated as present", () => {
    const fs = fakeSocketFs({}, { lstatThrows: { [user]: "EACCES" } });
    expect(resolveCageSocketPath("px", { uid: A, fs })).toBe(user);
  });

  test("no POSIX uid → legacy shapes", () => {
    expect(resolveCageSocketPath("px", { uid: null })).toBe(legacy);
    expect(resolveGroupSocketPath("unum", { uid: null })).toBe("/tmp/atmux-grp-unum/sock");
  });

  test("group servers follow the same rules", () => {
    expect(resolveGroupSocketPath("unum", { uid: A, fs: fakeSocketFs() })).toBe(
      "/tmp/atmux-1000/grp-unum/sock",
    );
    expect(resolveGroupSocketPath("unum", { uid: B, fs: fakeSocketFs() })).toBe(
      "/tmp/atmux-1001/grp-unum/sock",
    );
    const adopt = fakeSocketFs({
      "/tmp/atmux-grp-unum": dir(A),
      "/tmp/atmux-grp-unum/sock": sock(A),
    });
    expect(resolveGroupSocketPath("unum", { uid: A, fs: adopt })).toBe("/tmp/atmux-grp-unum/sock");
    const shared = fakeSocketFs({
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

describe("legacySocketState / legacySocketInfo", () => {
  const legacy = "/tmp/atmux-px/sock";
  test.each([
    ["absent", {}, "absent"],
    ["adoptable", { "/tmp/atmux-px": dir(A), [legacy]: sock(A) }, "adoptable"],
    ["shared-dir", { "/tmp/atmux-px": dir(A, 0o777), [legacy]: sock(A) }, "shared-dir"],
    ["foreign owner", { "/tmp/atmux-px": dir(0), [legacy]: sock(0) }, "foreign"],
    ["not a socket", { "/tmp/atmux-px": dir(A), [legacy]: file(A) }, "foreign"],
  ] as const)("%s", (_label, nodes, want) => {
    const fs = fakeSocketFs(nodes as Record<string, FakeNode>);
    expect(legacySocketState(legacy, { uid: A, fs })).toBe(want);
  });

  test("shared-dir carries the chain issue", () => {
    const fs = fakeSocketFs({ "/tmp": dir(0, 0o777), "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    expect(legacySocketInfo(legacy, { uid: A, fs })).toMatchObject({
      state: "shared-dir",
      issue: { problem: "shared-mode", path: "/tmp" },
    });
  });

  test("no POSIX uid + something present → adoptable", () => {
    const fs = fakeSocketFs({ [legacy]: sock(A) });
    expect(legacySocketState(legacy, { uid: null, fs })).toBe("adoptable");
  });
});

// ---------- isSocketListening ----------

describe("isSocketListening", () => {
  let scratch: string;
  let server: Server | null = null;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "sockdir-live-"));
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

  test("live legacy socket of ours in a SHARED dir → refused with the adopting fix", async () => {
    const fs = fakeSocketFs({ "/tmp/atmux-px": dir(A, 0o755), [legacy]: sock(A) });
    const p = settleSocketForCreate(user, user, legacy, {
      uid: A,
      fs,
      isListening: async () => true,
    });
    await expect(p).rejects.toBeInstanceOf(ConfigError);
    await expect(
      settleSocketForCreate(user, user, legacy, { uid: A, fs, isListening: async () => true }),
    ).rejects.toThrow(
      "chmod 700 /tmp/atmux-px — that keeps the server usable until it next restarts",
    );
  });

  test("live legacy socket behind an unsafe ANCESTOR → refused naming that ancestor", async () => {
    const fs = fakeSocketFs({ "/tmp": dir(0, 0o777), "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    await expect(
      settleSocketForCreate(user, user, legacy, { uid: A, fs, isListening: async () => true }),
    ).rejects.toThrow("unsafe directory chain: /tmp has mode 0777");
  });

  test("dead legacy socket in a shared dir → ignored, per-user path kept", async () => {
    const fs = fakeSocketFs({ "/tmp/atmux-px": dir(A, 0o777), [legacy]: sock(A) });
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
    const fs = fakeSocketFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    const out = await settleSocketForCreate(legacy, user, legacy, {
      uid: A,
      fs,
      isListening: async () => true,
    });
    expect(out).toBe(legacy);
  });

  test("dead adoptable legacy socket → removed, moved to the per-user path", async () => {
    const fs = fakeSocketFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
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
    const fs = fakeSocketFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
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
    const fs = fakeSocketFs({ [`/tmp/atmux-${team}`]: dir(A), [l]: sock(A) });
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
    const fs = fakeSocketFs({ "/tmp/atmux-px": dir(A), [legacy]: sock(A) });
    expect(await settleSocketForCreate(user, user, legacy, { uid: A, fs })).toBe(user);
  });

  test("no legacy socket → unchanged", async () => {
    expect(await settleSocketForCreate(user, user, legacy, { uid: A, fs: fakeSocketFs() })).toBe(
      user,
    );
  });
});
