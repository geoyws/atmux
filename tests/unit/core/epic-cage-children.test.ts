// ADR-252 (P0, t-65bec10b) — unit tests for `hasLiveEpicChildren`, the
// structural guard that refuses to wipe a parent tmpdir hosting live
// epic-team children. Every fs + tmux seam is injected so the suite is
// filesystem- + tmux-free and deterministic.
//
// Coverage matrix (task §4):
//   (a) a live child cage             ⇒ true
//   (b) no epics dir (ENOENT)         ⇒ false
//   (c) epics present, all dead       ⇒ false
//   (d) fail-safe on list-error       ⇒ true
//   (e) fail-safe on probe-throw      ⇒ true
//   + socket-resolution shape, uid injection, first-live-wins short-circuit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { hasLiveEpicChildren } from "../../../src/core/epic-cage-children.ts";

/** Fake tmux exposing only `session.listSessions`, recording the socket
 *  each factory call was keyed on. `sessionsBySocket` maps a resolved
 *  socket path → the session list that socket's server reports (absence
 *  ⇒ `[]`, i.e. a down server). */
function fakeTmuxFactory(
  sessionsBySocket: Record<string, Array<{ name: string; windows: number; created: number }>>,
  seenSockets: string[],
): (config: TmuxConfig) => TmuxNamespace {
  return (config: TmuxConfig) => {
    const socket = "socketPath" in config ? config.socketPath : `-L:${config.socket}`;
    seenSockets.push(socket);
    return {
      session: {
        async listSessions() {
          return sessionsBySocket[socket] ?? [];
        },
      },
    } as unknown as TmuxNamespace;
  };
}

const liveSession = { name: "atmux-e-x", windows: 3, created: 0 };

describe("hasLiveEpicChildren — structural P0 guard (ADR-252, t-65bec10b)", () => {
  test("(a) a live child cage ⇒ true", async () => {
    const seen: string[] = [];
    const r = await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => ["e-dead", "e-alive"],
      tmuxFactory: fakeTmuxFactory(
        { "/tmp/atmux-demo/epics/e-alive/tmux-0/default": [liveSession] },
        seen,
      ),
      uid: 0,
    });
    expect(r).toBe(true);
  });

  test("(b) no epics dir (ENOENT) ⇒ false — definitive no-children, NOT fail-safe", async () => {
    let factoryCalled = false;
    const r = await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => {
        // Mirror the default lister's ENOENT→[] behaviour: a missing
        // epics dir is the definitive "no children" signal.
        return [];
      },
      tmuxFactory: () => {
        factoryCalled = true;
        return {} as unknown as TmuxNamespace;
      },
      uid: 0,
    });
    expect(r).toBe(false);
    expect(factoryCalled).toBe(false); // no children ⇒ tmux never probed
  });

  test("(c) epics present but all dead ⇒ false", async () => {
    const seen: string[] = [];
    const r = await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => ["e-1", "e-2", "e-3"],
      // No entries ⇒ every listSessions returns [] ⇒ every cage dead.
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 0,
    });
    expect(r).toBe(false);
    // All three children were probed before concluding "no live".
    expect(seen).toEqual([
      "/tmp/atmux-demo/epics/e-1/tmux-0/default",
      "/tmp/atmux-demo/epics/e-2/tmux-0/default",
      "/tmp/atmux-demo/epics/e-3/tmux-0/default",
    ]);
  });

  test("(d) fail-safe on list-error ⇒ true (refuse removal on uncertainty)", async () => {
    let factoryCalled = false;
    const r = await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      tmuxFactory: () => {
        factoryCalled = true;
        return {} as unknown as TmuxNamespace;
      },
      uid: 0,
    });
    expect(r).toBe(true);
    expect(factoryCalled).toBe(false); // bailed at listing — never probed
  });

  test("(e) fail-safe on probe-throw ⇒ true (refuse removal on uncertainty)", async () => {
    const r = await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => ["e-garbled"],
      tmuxFactory: () =>
        ({
          session: {
            async listSessions(): Promise<never> {
              throw new Error("tmux: connect failed (garbled socket)");
            },
          },
        }) as unknown as TmuxNamespace,
      uid: 0,
    });
    expect(r).toBe(true);
  });

  test("first live child short-circuits — remaining siblings not probed", async () => {
    const seen: string[] = [];
    const r = await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => ["e-live", "e-never"],
      tmuxFactory: fakeTmuxFactory(
        { "/tmp/atmux-demo/epics/e-live/tmux-0/default": [liveSession] },
        seen,
      ),
      uid: 0,
    });
    expect(r).toBe(true);
    expect(seen).toEqual(["/tmp/atmux-demo/epics/e-live/tmux-0/default"]);
  });

  test("socket resolution honours injected uid (mirrors resolveTeamSocket scheme)", async () => {
    const seen: string[] = [];
    await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => ["e-1"],
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 1000,
    });
    expect(seen).toEqual(["/tmp/atmux-demo/epics/e-1/tmux-1000/default"]);
  });

  test("default uid falls back to process.getuid()/0 when not injected", async () => {
    const seen: string[] = [];
    const expectedUid = process.getuid?.() ?? 0;
    await hasLiveEpicChildren("/tmp/atmux-demo", {
      listEpicDir: async () => ["e-1"],
      tmuxFactory: fakeTmuxFactory({}, seen),
    });
    expect(seen).toEqual([`/tmp/atmux-demo/epics/e-1/tmux-${expectedUid}/default`]);
  });

  test("real default lister: absent epics dir on a temp tmpdir ⇒ false (ENOENT→[])", async () => {
    // No `listEpicDir` injection ⇒ exercises defaultListEpicDir's real
    // readdir against a path with no `epics/` subdir → ENOENT → [] → false.
    const r = await hasLiveEpicChildren("/tmp/atmux-nonexistent-adr252-probe", {
      tmuxFactory: () => {
        throw new Error("must not probe — no children");
      },
    });
    expect(r).toBe(false);
  });
});

describe("hasLiveEpicChildren — real default lister against the filesystem", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-adr252-children-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("real default lister: epics is a FILE (not a dir) ⇒ true (fail-safe rethrow)", async () => {
    // `<parentTmpdir>/epics` is a regular file → readdir throws ENOTDIR
    // (NOT ENOENT) → defaultListEpicDir rethrows → caller fails SAFE to
    // true. Exercises the non-ENOENT rethrow branch with the REAL lister.
    await writeFile(join(scratch, "epics"), "not a directory");
    const r = await hasLiveEpicChildren(scratch, {
      tmuxFactory: () => {
        throw new Error("must not probe — listing failed");
      },
    });
    expect(r).toBe(true);
  });

  test("real default lister: empty epics dir ⇒ false (lists cleanly, no children)", async () => {
    await mkdir(join(scratch, "epics"), { recursive: true });
    const r = await hasLiveEpicChildren(scratch, {
      tmuxFactory: () => {
        throw new Error("must not probe — no children");
      },
    });
    expect(r).toBe(false);
  });
});
