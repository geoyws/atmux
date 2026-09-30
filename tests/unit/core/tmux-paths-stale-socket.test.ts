// e-29 T1 — stale-legacy-socket removal matrix. All seams faked; no
// /tmp writes, no tmux spawns. Legacy path is getDefaultSocket(team)
// = ADR-305 `/tmp/atmux-<uid>/<team>/sock` (never created by the seam
// cases — exists is faked; the real-fs cases create it 0700).

import { describe, expect, test } from "bun:test";
import {
  existsSync as fsExistsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getDefaultSocket } from "../../../src/core/common.ts";
import {
  ensurePrivateSocketDir,
  type SocketPathIssue,
  UnsafeSocketPathError,
} from "../../../src/core/socket-dir.ts";
import {
  defaultRemoveLegacySocket,
  removeStaleLegacySocket,
  type StaleLegacySocketDeps,
} from "../../../src/core/tmux-paths.ts";
import { deadUnixSocket } from "../../helpers/dead-socket.ts";

const TEAM = "tmum-test-team";
// ADR-305: the path a stale socket shadows is the team's default socket —
// the per-user `/tmp/atmux-<uid>/<team>/sock` for this uid.
const LEGACY = getDefaultSocket(TEAM);
const OVERRIDE = "/tmp/tmum-override/tmux-0/default";

function deps(over: Partial<StaleLegacySocketDeps> = {}): StaleLegacySocketDeps {
  return {
    exists: () => false,
    isLive: async () => false,
    remove: () => {
      throw new Error("remove must not run");
    },
    // Socket-type gate: seam-doubled tests assume a socket unless the
    // case under test says otherwise; real-filesystem cases below omit
    // this seam to exercise the production lstat default.
    isSocket: () => true,
    log: () => {},
    ...over,
  };
}

/** Listen a real unix socket at `path` and return its closer. Bun unlinks
 *  the node on `server.close()`, so callers keep the listener up until
 *  after the gate runs; "dead" for the unit under test is declared by the
 *  faked `isLive` probe (a node:net listener is not a tmux server). */
function listenLive(path: string): Promise<() => Promise<void>> {
  const { promise, resolve, reject } = Promise.withResolvers<() => Promise<void>>();
  const server = createServer();
  server.on("error", reject);
  server.listen(path, () => {
    const close = (): Promise<void> => {
      const { promise: p, resolve: res } = Promise.withResolvers<void>();
      // Path may already be unlinked by the remover; never fail teardown.
      server.close(() => res());
      return p;
    };
    resolve(close);
  });
  return promise;
}

describe("removeStaleLegacySocket", () => {
  test("no legacy file → false, remove uncalled", async () => {
    let removed = 0;
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: () => false,
        remove: () => {
          removed += 1;
        },
      }),
    );
    expect(r).toBe(false);
    expect(removed).toBe(0);
  });

  test("live legacy server → false, never deleted", async () => {
    const removed: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: () => true,
        isLive: async () => true,
        remove: (p) => {
          removed.push(p);
        },
      }),
    );
    expect(r).toBe(false);
    expect(removed).toEqual([]);
  });

  test("dead legacy + live override → removed, log names the path", async () => {
    const removed: string[] = [];
    const logs: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: () => true,
        isLive: async (p) => p === OVERRIDE,
        remove: (p) => {
          removed.push(p);
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe(true);
    expect(removed).toEqual([LEGACY]);
    expect(logs.some((l) => l.includes(LEGACY) && l.includes(OVERRIDE))).toBe(true);
  });

  test("dead legacy + absent override → removed (absent-verified)", async () => {
    const removed: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: (p) => p === LEGACY,
        isLive: async () => false,
        remove: (p) => {
          removed.push(p);
        },
      }),
    );
    expect(r).toBe(true);
    expect(removed).toEqual([LEGACY]);
  });

  test("dead legacy + existing-but-dead override → false (ambiguous)", async () => {
    const removed: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: () => true,
        isLive: async () => false,
        remove: (p) => {
          removed.push(p);
        },
      }),
    );
    expect(r).toBe(false);
    expect(removed).toEqual([]);
  });

  test("override equals legacy path → false", async () => {
    let removed = 0;
    const r = await removeStaleLegacySocket(
      TEAM,
      LEGACY,
      deps({
        exists: () => true,
        isLive: async () => false,
        remove: () => {
          removed += 1;
        },
      }),
    );
    expect(r).toBe(false);
    expect(removed).toBe(0);
  });

  test("exists default (real fs) reachable without touching it on same-path", async () => {
    const r = await removeStaleLegacySocket(TEAM, LEGACY, {
      isLive: async () => true,
      remove: () => {
        throw new Error("remove must not run");
      },
    });
    expect(r).toBe(false);
  });

  test("remove failure → false + warning, no throw", async () => {
    const logs: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: (p) => p === LEGACY,
        isLive: async () => false,
        remove: () => {
          throw new Error("EPERM (test double)");
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe(false);
    expect(logs.some((l) => l.includes(LEGACY) && l.includes("leaving in place"))).toBe(true);
  });

  test("log defaults to stderr when seam omitted", async () => {
    const r = await removeStaleLegacySocket(TEAM, OVERRIDE, {
      exists: (p) => p === LEGACY,
      isLive: async () => false,
      isSocket: () => true,
      remove: () => {},
    });
    expect(r).toBe(true);
  });

  test("non-socket legacy (seam) → false, remove uncalled, log names path", async () => {
    const removed: string[] = [];
    const logs: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: (p) => p === LEGACY,
        isLive: async () => false,
        isSocket: () => false,
        remove: (p) => {
          removed.push(p);
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe(false);
    expect(removed).toEqual([]);
    expect(logs.some((l) => l.includes(LEGACY) && l.includes("leaving in place"))).toBe(true);
  });

  test("real regular file at legacy path → refused, file survives", async () => {
    const team = `${TEAM}-file-${process.pid}`;
    const legacy = getDefaultSocket(team);
    // 0700 chain — never leave the per-user root group/world-accessible.
    ensurePrivateSocketDir(legacy);
    try {
      writeFileSync(legacy, "", "utf8");
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(team, join(dirname(legacy), "override"), {
        isLive: async () => false,
        remove: () => {
          throw new Error("remove must not run for a regular file");
        },
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(false);
      expect(fsExistsSync(legacy)).toBe(true);
      expect(logs.some((l) => l.includes(legacy) && l.includes("regular file"))).toBe(true);
    } finally {
      await rm(dirname(legacy), { recursive: true, force: true });
    }
  });

  test("real directory at legacy path → refused, dir survives", async () => {
    const team = `${TEAM}-dir-${process.pid}`;
    const legacy = getDefaultSocket(team);
    ensurePrivateSocketDir(legacy);
    mkdirSync(legacy);
    try {
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(team, join(dirname(legacy), "override"), {
        isLive: async () => false,
        remove: () => {
          throw new Error("remove must not run for a directory");
        },
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(false);
      expect(fsExistsSync(legacy)).toBe(true);
      expect(logs.some((l) => l.includes(legacy) && l.includes("directory"))).toBe(true);
    } finally {
      await rm(dirname(legacy), { recursive: true, force: true });
    }
  });

  test("symlink-to-socket at legacy path → refused (no follow), link survives", async () => {
    const sockDir = await mkdtemp(join(tmpdir(), "stale-sock-target-"));
    const team = `${TEAM}-link-${process.pid}`;
    const legacy = getDefaultSocket(team);
    // 0700 chain — never leave the per-user root group/world-accessible.
    ensurePrivateSocketDir(legacy);
    let closeTarget: (() => Promise<void>) | undefined;
    try {
      const target = join(sockDir, "real.sock");
      closeTarget = await listenLive(target);
      expect(fsExistsSync(target)).toBe(true);
      symlinkSync(target, legacy);
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(team, join(dirname(legacy), "override"), {
        isLive: async () => false,
        remove: () => {
          throw new Error("remove must not run for a symlink");
        },
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(false);
      expect(fsExistsSync(legacy)).toBe(true);
      expect(logs.some((l) => l.includes(legacy) && l.includes("symlink"))).toBe(true);
    } finally {
      await closeTarget?.();
      await rm(dirname(legacy), { recursive: true, force: true });
      await rm(sockDir, { recursive: true, force: true });
    }
  });

  test("real dead socket at legacy path → removed via production seams", async () => {
    const team = `${TEAM}-sock-${process.pid}`;
    const legacy = getDefaultSocket(team);
    // 0700 chain — never leave the per-user root group/world-accessible.
    ensurePrivateSocketDir(legacy);
    try {
      // A server that died without unlinking its socket (SIGKILL).
      await deadUnixSocket(legacy);
      expect(lstatSync(legacy).isSocket()).toBe(true);
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(team, join(dirname(legacy), "override"), {
        isLive: async () => false,
        remove: defaultRemoveLegacySocket,
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(true);
      expect(fsExistsSync(legacy)).toBe(false);
      expect(logs.some((l) => l.includes(legacy) && l.includes("removed"))).toBe(true);
    } finally {
      await rm(dirname(legacy), { recursive: true, force: true });
    }
  });

  test("production remover: a socket its own connect probe finds live is kept, whatever isLive said", async () => {
    const team = `${TEAM}-live-${process.pid}`;
    const legacy = getDefaultSocket(team);
    ensurePrivateSocketDir(legacy);
    let closeServer: (() => Promise<void>) | undefined;
    try {
      closeServer = await listenLive(legacy);
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(team, join(dirname(legacy), "override"), {
        isLive: async () => false,
        remove: defaultRemoveLegacySocket,
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(false);
      expect(fsExistsSync(legacy)).toBe(true);
      expect(logs.some((l) => l.includes("not removed (a server accepts connections on it)"))).toBe(
        true,
      );
    } finally {
      await closeServer?.();
      await rm(dirname(legacy), { recursive: true, force: true });
    }
  });
});

// ---------- ADR-305 revision 4: a guard refusal is never "dead" ----------

const REFUSAL: SocketPathIssue = {
  path: "/tmp/atmux-0",
  problem: "foreign-owner",
  detail: "is owned by uid 4302, not uid 0",
  hint: "have its owner or root remove /tmp/atmux-0",
};

describe("removeStaleLegacySocket — rev 4", () => {
  test("isLive throws the guard's refusal on the legacy path → left in place, remove never runs", async () => {
    const logs: string[] = [];
    let probes = 0;
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: () => true,
        isLive: async (p) => {
          probes += 1;
          if (p === LEGACY) throw new UnsafeSocketPathError(p, REFUSAL);
          return false;
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe(false);
    // The override is never even probed: nothing after the refusal runs.
    expect(probes).toBe(1);
    expect(logs).toEqual([
      `[atmux start] legacy socket ${LEGACY} left in place — cannot probe it: refusing tmux socket ${LEGACY}: /tmp/atmux-0 is owned by uid 4302, not uid 0 (hint: have its owner or root remove /tmp/atmux-0)`,
    ]);
  });

  test("the override probe throws → left in place", async () => {
    const logs: string[] = [];
    const r = await removeStaleLegacySocket(
      TEAM,
      OVERRIDE,
      deps({
        exists: (p) => p === LEGACY,
        isLive: async (p) => {
          if (p === OVERRIDE) throw "spawn failed";
          return false;
        },
        log: (s) => {
          logs.push(s);
        },
      }),
    );
    expect(r).toBe(false);
    expect(logs).toEqual([
      `[atmux start] legacy socket ${LEGACY} left in place — cannot probe ${OVERRIDE}: spawn failed`,
    ]);
  });

  /** The team's per-user socket dir replaced by a symlink to another
   *  private dir that holds a socket — the single-uid shape of the review
   *  repro (`/tmp/atmux-0/kanban -> /tmp/atmux-journal`). A path lstat /
   *  path rm follows the link; the descriptor walk refuses it. */
  async function plantedTeamDir(
    label: string,
    victim: (sock: string) => Promise<(() => Promise<void>) | undefined>,
  ): Promise<{ team: string; legacy: string; victimSock: string; cleanup: () => Promise<void> }> {
    const team = `${TEAM}-${label}-${process.pid}`;
    const legacy = getDefaultSocket(team);
    ensurePrivateSocketDir(legacy);
    rmSync(dirname(legacy), { recursive: true, force: true });
    const victimDir = await mkdtemp(join(tmpdir(), "stale-victim-"));
    const victimSock = join(victimDir, "sock");
    const close = await victim(victimSock);
    symlinkSync(victimDir, dirname(legacy));
    return {
      team,
      legacy,
      victimSock,
      async cleanup() {
        await close?.();
        rmSync(dirname(legacy), { force: true });
        await rm(victimDir, { recursive: true, force: true });
      },
    };
  }

  test("production seams: a LIVE socket behind a symlinked team dir is never unlinked, even when isLive says dead", async () => {
    const p = await plantedTeamDir("plant-live", (s) => listenLive(s));
    try {
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(p.team, join(tmpdir(), "no-such-override"), {
        // The ccd9f275 bug: a guard refusal swallowed into "dead".
        isLive: async () => false,
        remove: defaultRemoveLegacySocket,
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(false);
      expect(lstatSync(p.victimSock).isSocket()).toBe(true);
      expect(logs.some((l) => l.includes(p.legacy) && l.includes("leaving in place"))).toBe(true);
    } finally {
      await p.cleanup();
    }
  });

  test("production remover: a DEAD socket behind a symlinked team dir is never unlinked, even past the socket gate", async () => {
    const p = await plantedTeamDir("plant-dead", async (s) => {
      await deadUnixSocket(s);
      return undefined;
    });
    try {
      const logs: string[] = [];
      const r = await removeStaleLegacySocket(p.team, join(tmpdir(), "no-such-override"), {
        isLive: async () => false,
        // Force the gate open: the remover's own walk must still refuse.
        isSocket: () => true,
        remove: defaultRemoveLegacySocket,
        log: (s) => {
          logs.push(s);
        },
      });
      expect(r).toBe(false);
      expect(lstatSync(p.victimSock).isSocket()).toBe(true);
      expect(
        logs.some((l) => l.includes(`not removed (unsafe: ${dirname(p.legacy)} is a symlink)`)),
      ).toBe(true);
    } finally {
      await p.cleanup();
    }
  });
});
