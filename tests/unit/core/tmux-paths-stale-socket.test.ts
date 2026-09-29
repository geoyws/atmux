// e-29 T1 — stale-legacy-socket removal matrix. All seams faked; no
// /tmp writes, no tmux spawns. Legacy path is getDefaultSocket(team)
// = /tmp/atmux-<team>/sock (never created here — exists is faked).

import { describe, expect, test } from "bun:test";
import { existsSync as fsExistsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRemoveLegacySocket,
  removeStaleLegacySocket,
  type StaleLegacySocketDeps,
} from "../../../src/core/tmux-paths.ts";

const TEAM = "tmum-test-team";
const LEGACY = `/tmp/atmux-${TEAM}/sock`;
const OVERRIDE = "/tmp/tmum-override/tmux-0/default";

function deps(over: Partial<StaleLegacySocketDeps> = {}): StaleLegacySocketDeps {
  return {
    exists: () => false,
    isLive: async () => false,
    remove: () => {
      throw new Error("remove must not run");
    },
    log: () => {},
    ...over,
  };
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
      remove: () => {},
    });
    expect(r).toBe(true);
  });

  test("defaultRemoveLegacySocket deletes a real temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-sock-rm-"));
    try {
      const target = join(dir, "sock");
      writeFileSync(target, "", "utf8");
      defaultRemoveLegacySocket(target);
      expect(fsExistsSync(target)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
