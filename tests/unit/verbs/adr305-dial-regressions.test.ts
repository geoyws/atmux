// ADR-305 revision 3 — regressions for the second review of the socket
// guard. Each test here uses only the public surface that already existed
// at a9f96ac2 (revision 2), so the same file runs against that revision
// and FAILS there on its assertions, and passes on revision 3.
//
//   1. doctor checked a socket with an inspect-only walk (a missing
//      directory counts as safe) and then dialled it raw. A uid that
//      squatted /tmp/atmux-<uid> and renames it away and back wins that
//      race (e2e beat 12 measures it). Revision 3 guards the dial itself:
//      a missing squattable directory is created by the caller BEFORE the
//      dial, which locks the squatter out. Proven here on the real fs
//      through both doctor dial sites (tmux-agent-env,
//      legacy-window-name-format).
//   2. test-reaper dialled `kill-server` without the guard and removed any
//      directory it matched: a planted `sock` symlink was killed through
//      and the directory removed. Revision 3 refuses both.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Team } from "../../../src/schema/team.ts";
import { checkAgentShellEnv } from "../../../src/verbs/doctor/agent-env.ts";
import { checkLegacyWindowNameFormat } from "../../../src/verbs/doctor/cockpit.ts";
import { testReaper } from "../../../src/verbs/test-reaper.ts";

const UID = process.getuid?.() ?? 0;
const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A fresh `atmux-*` name directly under the shared sticky /tmp — the
 *  shape another uid can squat. */
function squattable(tag: string): string {
  const p = `/tmp/atmux-r3${tag}${process.pid.toString(36)}${Date.now().toString(36)}`;
  cleanup.push(p);
  return p;
}

/** `/tmp` is the root-owned sticky shared directory these tests model. */
const tmpIsShared = ((): boolean => {
  try {
    const st = lstatSync("/tmp");
    return st.isDirectory() && st.uid === 0 && (st.mode & 0o1000) !== 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!tmpIsShared || process.platform !== "linux")(
  "review item 1 — doctor creates a squattable directory before it dials",
  () => {
    test("tmux-agent-env: a missing /tmp/atmux-* is created 0700 (ours) before the has-session dial", async () => {
      const dir = squattable("ae");
      const socket = join(dir, "sock");
      expect(existsSync(dir)).toBe(false);
      // `isSocket` models the race's first step: the squatter's socket was
      // there when the file was checked, then renamed away. The default
      // tmux spawn is used, as in production.
      const rows = await checkAgentShellEnv(null, {
        sockets: [{ socket, owner: "race" }],
        isSocket: async () => true,
      });
      expect(rows).toEqual([]);
      // Revision 2 dialled after an inspect-only check and left the name
      // free for the squatter to rename back; revision 3 owns it first.
      const st = lstatSync(dir);
      expect(st.isDirectory()).toBe(true);
      expect(st.uid).toBe(UID);
      expect(st.mode & 0o777).toBe(0o700);
    });

    test("legacy-window-name-format: same, through the cage socket of a team's tmuxTmpdir", async () => {
      const dir = squattable("lw");
      const team = {
        name: `r3lw${process.pid}`,
        tmuxTmpdir: dir,
        members: [],
      } as unknown as Team;
      const rows = await checkLegacyWindowNameFormat(team, {
        loadCockpitFn: async () => null,
        socketExists: async () => true,
      });
      expect(rows).toEqual([]);
      const st = lstatSync(dir);
      expect(st.uid).toBe(UID);
      expect(st.mode & 0o777).toBe(0o700);
      expect(existsSync(join(dir, `tmux-${UID}`))).toBe(false);
    });
  },
);

// ---------- review item 2: test-reaper ----------

const DEAD_PID = 999_999_931;

describe("review item 2 — test-reaper never kills through, or removes, what is not ours alone", () => {
  let savedPath: string | undefined;
  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    savedPath = undefined;
  });

  /** Scratch root + a private (0700) fixture dir with a valid sidecar;
   *  a stub `tmux` first on PATH logs every invocation. */
  async function setup(name: string): Promise<{ root: string; dir: string; log: string }> {
    const root = await mkdtemp(join(tmpdir(), "r3-reaper-"));
    cleanup.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "argv.log");
    writeFileSync(join(bin, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, {
      mode: 0o755,
    });
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    const dir = join(root, name);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(
      join(dir, ".leak-tracker.json"),
      JSON.stringify({
        tmuxSocket: join(dir, "sock"),
        socketDir: dir,
        parentPid: DEAD_PID,
        createdAt: Math.floor(Date.now() / 1000) - 7_200,
      }),
    );
    return { root, dir, log };
  }

  async function reap(root: string): Promise<string> {
    const out: string[] = [];
    await testReaper(["--prefix", "fixture", "--json"], {
      tmpDir: root,
      stdout: (t) => out.push(t),
      stderr: () => {},
    });
    return out.join("");
  }

  test("a `sock` symlink planted to another server: never dialled, directory kept", async () => {
    const { root, dir, log } = await setup("fixture-planted-old");
    // The victim: a live server elsewhere (a cage socket in the attack).
    const victimDir = await mkdtemp(join(tmpdir(), "r3-victim-"));
    cleanup.push(victimDir);
    const victim = join(victimDir, "sock");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(victim, () => r()));
    symlinkSync(victim, join(dir, "sock"));

    const json = await reap(root);
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    expect(existsSync(dir)).toBe(true);
    expect(json).not.toContain('"reaped"');
  });

  test.skipIf(UID !== 0)(
    "a directory owned by another uid (as root): never dialled, never removed",
    async () => {
      const { root, dir, log } = await setup("fixture-foreign-old");
      chownSync(dir, 4242, 4242);
      const json = await reap(root);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
      expect(existsSync(dir)).toBe(true);
      expect(json).not.toContain('"reaped"');
    },
  );

  test("positive control: our own private fixture is still dialled and removed", async () => {
    const { root, dir, log } = await setup("fixture-own-old");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(join(dir, "sock"), () => r()));
    const json = await reap(root);
    expect(readFileSync(log, "utf8")).toBe(`-S ${join(dir, "sock")} kill-server\n`);
    expect(existsSync(dir)).toBe(false);
    expect(json).toContain('"reaped"');
    await rm(dir, { recursive: true, force: true });
  });
});
