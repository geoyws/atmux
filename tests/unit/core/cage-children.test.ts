// ADR-252 (P0, t-65bec10b) — unit tests for `hasLiveChildCages`, the
// structural guard that refuses to wipe a parent tmpdir hosting live
// CHILD cages. Every fs + tmux seam is injected so the suite is
// filesystem- + tmux-free and deterministic (the two `describe`s at the
// bottom deliberately exercise the REAL lister against a temp dir).
//
// ADR-280 stage 4 migrated this file from `epic-cage-children.test.ts`.
// Stage 3 renamed the module (`epic-cage-children.ts` →
// `cage-children.ts`) and generalised `hasLiveEpicChildren` →
// `hasLiveChildCages`: the glob was `<parent>/epics/*` and is now
// structural, probing every entry under the parent tmpdir at ONE and TWO
// levels down. So the guard covers strictly MORE than before — the
// historical `epics/<epicId>` layout is now just the two-level case, and
// a directly-nested child cage is covered for the first time. The
// coverage matrix below carries every original case forward and adds the
// ones the generalisation created.
//
// Coverage matrix:
//   (a) a live child cage, GROUPED `<parent>/<group>/<child>`  ⇒ true
//   (a') a live child cage, DIRECTLY nested `<parent>/<child>` ⇒ true  [new]
//   (b) absent parent tmpdir (ENOENT)                          ⇒ false
//   (c) children present, all dead                             ⇒ false
//   (d) fail-safe on parent list-error (EACCES)                ⇒ true
//   (e) fail-safe on probe-throw                               ⇒ true
//   (f) the parent's OWN socket artefacts are skipped          [new]
//   (g) nested-level ENOENT/ENOTDIR contributes no candidates  [new]
//   (h) nested-level non-ENOENT error                          ⇒ true  [new]
//   + socket-resolution shape, uid injection, first-live-wins short-circuit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxConfig, TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { hasLiveChildCages } from "../../../src/core/cage-children.ts";

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

/** A lister keyed by directory, mirroring `defaultListDir`'s contract:
 *  an unlisted directory yields `[]` (definitively nothing nested). */
function listerFor(tree: Record<string, string[]>): (dir: string) => Promise<string[]> {
  return async (dir: string) => tree[dir] ?? [];
}

const liveSession = { name: "atmux-e-x", windows: 3, created: 0 };

describe("hasLiveChildCages — structural P0 guard (ADR-252, t-65bec10b)", () => {
  test("(a) a live GROUPED child cage ⇒ true (the historical epics/<epicId> layout)", async () => {
    const seen: string[] = [];
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({
        "/tmp/atmux-demo": ["epics"],
        "/tmp/atmux-demo/epics": ["e-dead", "e-alive"],
      }),
      tmuxFactory: fakeTmuxFactory(
        { "/tmp/atmux-demo/epics/e-alive/tmux-0/default": [liveSession] },
        seen,
      ),
      uid: 0,
    });
    expect(r).toBe(true);
  });

  test("(a') a live DIRECTLY-NESTED child cage ⇒ true — covered for the first time by the generalisation", async () => {
    const seen: string[] = [];
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({ "/tmp/atmux-demo": ["child-a"] }),
      tmuxFactory: fakeTmuxFactory({ "/tmp/atmux-demo/child-a/tmux-0/default": [liveSession] }, seen),
      uid: 0,
    });
    expect(r).toBe(true);
    // Shape 1 is probed before descending, so the ONE probe is the child itself.
    expect(seen).toEqual(["/tmp/atmux-demo/child-a/tmux-0/default"]);
  });

  test("(b) absent parent tmpdir (ENOENT) ⇒ false — definitive no-children, NOT fail-safe", async () => {
    let factoryCalled = false;
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      // Mirror the default lister's ENOENT→[] behaviour: a missing parent
      // tmpdir is the definitive "no children" signal.
      listDir: async () => [],
      tmuxFactory: () => {
        factoryCalled = true;
        return {} as unknown as TmuxNamespace;
      },
      uid: 0,
    });
    expect(r).toBe(false);
    expect(factoryCalled).toBe(false); // no children ⇒ tmux never probed
  });

  test("(b') an INJECTED lister that RE-THROWS ENOENT lands on the same verdict as the default one", async () => {
    // `defaultListDir` absorbs ENOENT into `[]`, but the walker repeats the
    // check so an injected lister cannot flip the verdict to fail-safe.
    const r = await hasLiveChildCages("/tmp/atmux-gone", {
      listDir: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
      tmuxFactory: () => {
        throw new Error("must not probe — no children");
      },
      uid: 0,
    });
    expect(r).toBe(false);
  });

  test("(c) children present but all dead ⇒ false, and every candidate was probed", async () => {
    const seen: string[] = [];
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({
        "/tmp/atmux-demo": ["epics"],
        "/tmp/atmux-demo/epics": ["e-1", "e-2", "e-3"],
      }),
      // No entries ⇒ every listSessions returns [] ⇒ every cage dead.
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 0,
    });
    expect(r).toBe(false);
    // The group dir is probed as a shape-1 candidate first (harmless — a
    // non-cage path reports zero sessions), then all three grouped children.
    expect(seen).toEqual([
      "/tmp/atmux-demo/epics/tmux-0/default",
      "/tmp/atmux-demo/epics/e-1/tmux-0/default",
      "/tmp/atmux-demo/epics/e-2/tmux-0/default",
      "/tmp/atmux-demo/epics/e-3/tmux-0/default",
    ]);
  });

  test("(d) fail-safe on parent list-error ⇒ true (refuse removal on uncertainty)", async () => {
    let factoryCalled = false;
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: async () => {
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
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({ "/tmp/atmux-demo": ["garbled"] }),
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

  test("(f) the parent's OWN socket artefacts (`sock`, `tmux-<uid>`) are skipped, never probed", async () => {
    let factoryCalled = false;
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({ "/tmp/atmux-demo": ["sock", "tmux-0", "tmux-1000"] }),
      tmuxFactory: () => {
        factoryCalled = true;
        return {} as unknown as TmuxNamespace;
      },
      uid: 0,
    });
    expect(r).toBe(false);
    expect(factoryCalled).toBe(false);
  });

  test("(f') a grouped child named like a parent artefact is skipped at the nested level too", async () => {
    const seen: string[] = [];
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({
        "/tmp/atmux-demo": ["group"],
        "/tmp/atmux-demo/group": ["sock", "tmux-0", "real-child"],
      }),
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 0,
    });
    expect(r).toBe(false);
    expect(seen).toEqual([
      "/tmp/atmux-demo/group/tmux-0/default",
      "/tmp/atmux-demo/group/real-child/tmux-0/default",
    ]);
  });

  test("(g) a nested-level ENOENT/ENOTDIR contributes no candidates and does NOT trip fail-safe", async () => {
    const seen: string[] = [];
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: async (dir: string) => {
        if (dir === "/tmp/atmux-demo") return ["a-file", "a-dir"];
        if (dir === "/tmp/atmux-demo/a-file") {
          throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
        }
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      },
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 0,
    });
    expect(r).toBe(false);
    // Both first-level entries still got their shape-1 probe; neither
    // descent produced a candidate.
    expect(seen).toEqual([
      "/tmp/atmux-demo/a-file/tmux-0/default",
      "/tmp/atmux-demo/a-dir/tmux-0/default",
    ]);
  });

  test("(h) a nested-level non-ENOENT list error ⇒ true (fail-safe)", async () => {
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: async (dir: string) => {
        if (dir === "/tmp/atmux-demo") return ["locked"];
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      tmuxFactory: fakeTmuxFactory({}, []),
      uid: 0,
    });
    expect(r).toBe(true);
  });

  test("first live child short-circuits — remaining siblings not probed", async () => {
    const seen: string[] = [];
    const r = await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({
        "/tmp/atmux-demo": ["epics"],
        "/tmp/atmux-demo/epics": ["e-live", "e-never"],
      }),
      tmuxFactory: fakeTmuxFactory(
        { "/tmp/atmux-demo/epics/e-live/tmux-0/default": [liveSession] },
        seen,
      ),
      uid: 0,
    });
    expect(r).toBe(true);
    expect(seen).toEqual([
      "/tmp/atmux-demo/epics/tmux-0/default",
      "/tmp/atmux-demo/epics/e-live/tmux-0/default",
    ]);
  });

  test("socket resolution honours injected uid (mirrors resolveTeamSocket scheme)", async () => {
    const seen: string[] = [];
    await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({
        "/tmp/atmux-demo": ["epics"],
        "/tmp/atmux-demo/epics": ["e-1"],
      }),
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 1000,
    });
    expect(seen).toEqual([
      "/tmp/atmux-demo/epics/tmux-1000/default",
      "/tmp/atmux-demo/epics/e-1/tmux-1000/default",
    ]);
  });

  test("default uid falls back to process.getuid()/0 when not injected", async () => {
    const seen: string[] = [];
    const expectedUid = process.getuid?.() ?? 0;
    await hasLiveChildCages("/tmp/atmux-demo", {
      listDir: listerFor({
        "/tmp/atmux-demo": ["epics"],
        "/tmp/atmux-demo/epics": ["e-1"],
      }),
      tmuxFactory: fakeTmuxFactory({}, seen),
    });
    expect(seen).toEqual([
      `/tmp/atmux-demo/epics/tmux-${expectedUid}/default`,
      `/tmp/atmux-demo/epics/e-1/tmux-${expectedUid}/default`,
    ]);
  });

  test("real default lister: absent parent tmpdir ⇒ false (ENOENT→[])", async () => {
    // No `listDir` injection ⇒ exercises defaultListDir's real readdir
    // against a path that does not exist → ENOENT → [] → false.
    const r = await hasLiveChildCages("/tmp/atmux-nonexistent-adr252-probe", {
      tmuxFactory: () => {
        throw new Error("must not probe — no children");
      },
    });
    expect(r).toBe(false);
  });
});

describe("hasLiveChildCages — real default lister against the filesystem", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "atmux-adr252-children-"));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("real default lister: the parent tmpdir is a FILE ⇒ true is NOT returned — ENOTDIR is definitive", async () => {
    // A plain file where the parent tmpdir was expected → readdir throws
    // ENOTDIR → defaultListDir returns [] → no children → false. ENOTDIR
    // is the definitive "nothing nested here" signal, not uncertainty.
    const asFile = join(scratch, "not-a-dir");
    await writeFile(asFile, "not a directory");
    const r = await hasLiveChildCages(asFile, {
      tmuxFactory: () => {
        throw new Error("must not probe — no children");
      },
    });
    expect(r).toBe(false);
  });

  test("real default lister: empty parent dir ⇒ false (lists cleanly, no children)", async () => {
    const r = await hasLiveChildCages(scratch, {
      tmuxFactory: () => {
        throw new Error("must not probe — no children");
      },
    });
    expect(r).toBe(false);
  });

  test("real default lister: only the parent's OWN socket artefacts present ⇒ false, never probed", async () => {
    // `<parent>/sock` (default-cage convention) and `<parent>/tmux-<uid>`
    // (explicit tmuxTmpdir) both belong to the parent, so a parent that
    // has only its own socket must stay removable.
    await mkdir(join(scratch, "sock"), { recursive: true });
    await mkdir(join(scratch, `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
    const r = await hasLiveChildCages(scratch, {
      tmuxFactory: () => {
        throw new Error("must not probe — parent artefacts only");
      },
    });
    expect(r).toBe(false);
  });

  test("real default lister: a NUL byte in the parent path ⇒ true (defaultListDir rethrows non-ENOENT)", async () => {
    // Null bytes are rejected by the real `readdir` before any tmux
    // probing can happen, so the public guard must fail safe to `true`.
    const nulParent = `${scratch}\0nul`;
    const r = await hasLiveChildCages(nulParent, {
      tmuxFactory: () => {
        throw new Error("must not probe — listing failed before tmux");
      },
    });
    expect(r).toBe(true);
  });

  test("real default lister: a plain FILE beside child dirs contributes no candidates (ENOTDIR→[])", async () => {
    // The second-level descent readdir()s a regular file → ENOTDIR → [] →
    // `continue`, rather than tripping the fail-safe.
    const seen: string[] = [];
    await writeFile(join(scratch, "notes.txt"), "just a file");
    await mkdir(join(scratch, "epics", "e-dead"), { recursive: true });
    const r = await hasLiveChildCages(scratch, {
      tmuxFactory: fakeTmuxFactory({}, seen),
      uid: 0,
    });
    expect(r).toBe(false);
    expect(seen).toContain(join(scratch, "epics", "e-dead", "tmux-0", "default"));
    expect(seen).toContain(join(scratch, "notes.txt", "tmux-0", "default"));
  });

  test("real default lister: a live GROUPED child on the real tree ⇒ true", async () => {
    // Full end-to-end shape with the real lister: only the socket the
    // grouped child resolves to reports a session.
    const seen: string[] = [];
    await mkdir(join(scratch, "epics", "e-alive"), { recursive: true });
    const liveSocket = join(scratch, "epics", "e-alive", "tmux-0", "default");
    const r = await hasLiveChildCages(scratch, {
      tmuxFactory: fakeTmuxFactory({ [liveSocket]: [liveSession] }, seen),
      uid: 0,
    });
    expect(r).toBe(true);
    expect(seen).toContain(liveSocket);
  });
});
