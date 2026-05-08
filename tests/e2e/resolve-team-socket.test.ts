// Integration tests for `resolveTeamSocket` (t-add5976a — read-side
// tmuxTmpdir honour). Spins a real tmux server under a custom
// TMUX_TMPDIR, opens an atmux-<team> session, and proves:
//
//   Beat 1: resolveTeamSocket(team) reaches the live session via
//     createTmux + hasSession (positive path — [up] for a
//     tmuxTmpdir-configured team).
//   Beat 2: getDefaultSocket(team.name) does NOT reach the live
//     session, while resolveTeamSocket does. This is the [down]→[up]
//     repro that motivated the fix — atmux status was reporting [down]
//     for project-local .atmux/tmux cages because the canonical
//     fallback path was wrong.
//
// Skipped when tmux binary is absent (CI without tmux).
//
// Pattern adapted from tests/e2e/fallback-cage.test.ts (real tmux
// server + Bun.spawnSync env-pinned probes).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmux } from "../../src/abstractions/tmux.ts";
import { getDefaultSocket, resolveTeamSocket } from "../../src/core/common.ts";

function probeBin(cmd: string[]): boolean {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "ignore", stderr: "ignore" });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

const HAS_TMUX = probeBin(["tmux", "-V"]);

/** Run tmux against a specific TMUX_TMPDIR — the env-pinned form lets
 *  the underlying server build its own `<TMUX_TMPDIR>/tmux-<uid>/default`
 *  socket path the same way bash's `atmux start` does. */
function tmuxEnv(
  argv: string[],
  tmuxTmpdir: string,
): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["tmux", ...argv],
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

describe("e2e t-add5976a resolveTeamSocket — real tmux honours team.tmuxTmpdir", () => {
  const TEAM = "e2e-rts";
  const SESSION = `atmux-${TEAM}`;
  let workDir: string;
  let tmuxTmpdir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "atmux-e2e-rts-"));
    tmuxTmpdir = join(workDir, ".atmux", "tmux");
    // tmux creates `<TMUX_TMPDIR>/tmux-<uid>/` itself on first invocation;
    // we just need the parent to exist.
    await Bun.spawnSync({ cmd: ["mkdir", "-p", tmuxTmpdir] }).exitCode;
  });

  afterEach(async () => {
    // Best-effort tear-down — kill the cage server if still alive (idempotent;
    // non-zero "no server" is fine).
    tmuxEnv(["kill-server"], tmuxTmpdir);
    await rm(workDir, { recursive: true, force: true });
  });

  test.skipIf(!HAS_TMUX)(
    "Beat 1 (positive): resolveTeamSocket reaches a session opened under custom TMUX_TMPDIR",
    async () => {
      // Start a real tmux server with the custom tmpdir + a detached
      // session named atmux-<team>. This is the post-`atmux start` shape
      // a bash-launched team produces.
      const newSess = tmuxEnv(
        ["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"],
        tmuxTmpdir,
      );
      expect(newSess.exitCode).toBe(0);

      // Resolver picks the right path for a tmuxTmpdir-configured team.
      const socketPath = resolveTeamSocket(
        { name: TEAM, tmuxTmpdir },
        { uid: process.getuid?.() ?? 0 },
      );
      expect(socketPath).toBe(
        `${tmuxTmpdir}/tmux-${process.getuid?.() ?? 0}/default`,
      );

      // The abstraction's tmux namespace at that path can see the session.
      const tmux = createTmux({ socketPath });
      const found = await tmux.session.hasSession(SESSION);
      expect(found).toBe(true);
    },
  );

  test.skipIf(!HAS_TMUX)(
    "Beat 2 ([down]→[up] repro): canonical fallback misses; resolveTeamSocket finds",
    async () => {
      // Same shape — real tmux session under custom TMUX_TMPDIR.
      const newSess = tmuxEnv(
        ["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"],
        tmuxTmpdir,
      );
      expect(newSess.exitCode).toBe(0);

      // Pre-fix path: status used getDefaultSocket(team.name) →
      // /tmp/atmux-<team>/sock — which is NOT where this session lives.
      // hasSession returns false → status renders [down]. This is the
      // bug the dispatch describes.
      const canonicalSocket = getDefaultSocket(TEAM);
      expect(canonicalSocket).toBe(`/tmp/atmux-${TEAM}/sock`);
      const tmuxCanonical = createTmux({ socketPath: canonicalSocket });
      const foundCanonical = await tmuxCanonical.session.hasSession(SESSION);
      expect(foundCanonical).toBe(false); // [down] — false positive

      // Post-fix path: resolveTeamSocket honours team.tmuxTmpdir →
      // socket exists, hasSession returns true → status renders [up].
      const resolvedSocket = resolveTeamSocket(
        { name: TEAM, tmuxTmpdir },
        { uid: process.getuid?.() ?? 0 },
      );
      const tmuxResolved = createTmux({ socketPath: resolvedSocket });
      const foundResolved = await tmuxResolved.session.hasSession(SESSION);
      expect(foundResolved).toBe(true); // [up] — correct
    },
  );
});
