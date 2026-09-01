// Real-tmux integration for `resolveTeamSocket` (t-add5976a — read-side
// tmuxTmpdir honour). Spins a real tmux server under a custom
// TMUX_TMPDIR, opens a bare `team.name` session, and proves:
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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultSocket, resolveTeamSocket } from "../../src/core/common.ts";
import {
  CANONICAL_ATMUX_TMUX_CONF_PATH,
  createCanonicalAtmuxTmux,
  setCanonicalAtmuxTmuxHome,
} from "../helpers/tmux.ts";

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
  homeDir: string,
): { exitCode: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, HOME: homeDir, TMUX_TMPDIR: tmuxTmpdir } as NodeJS.ProcessEnv;
  delete env.TMUX;
  const proc = Bun.spawnSync({
    cmd: ["tmux", "-f", CANONICAL_ATMUX_TMUX_CONF_PATH, ...argv],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout?.toString() ?? "",
    stderr: proc.stderr?.toString() ?? "",
  };
}

describe("real-tmux integration for t-add5976a resolveTeamSocket — tmux honours team.tmuxTmpdir", () => {
  const TEAM = "e2e-rts";
  const SESSION = TEAM;
  let workDir: string;
  let homeDir: string;
  let tmuxTmpdir: string;
  let restoreHome: (() => void) | undefined;
  let priorTmux: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp("/tmp/rts-");
    homeDir = join(workDir, "home");
    await mkdir(homeDir, { recursive: true });
    tmuxTmpdir = join(workDir, ".atmux", "tmux");
    await mkdir(tmuxTmpdir, { recursive: true });
    restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
    priorTmux = process.env.TMUX;
    delete process.env.TMUX;
  });

  afterEach(async () => {
    restoreHome?.();
    restoreHome = undefined;
    if (priorTmux !== undefined) process.env.TMUX = priorTmux;
    else delete process.env.TMUX;
    // Best-effort tear-down — kill the cage server if still alive (idempotent;
    // non-zero "no server" is fine).
    tmuxEnv(["kill-server"], tmuxTmpdir, homeDir);
    await rm(workDir, { recursive: true, force: true });
  });

  test.skipIf(!HAS_TMUX)(
    "Beat 1 (positive): resolveTeamSocket reaches a real tmux session opened under custom TMUX_TMPDIR",
    async () => {
      // Start a real tmux server with the custom tmpdir + a detached
      // session named `team.name`. This is the post-`atmux start` shape
      // a bash-launched team produces.
      const newSess = tmuxEnv(
        ["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"],
        tmuxTmpdir,
        homeDir,
      );
      expect(newSess.exitCode).toBe(0);

      // Resolver picks the right path for a tmuxTmpdir-configured team.
      const socketPath = resolveTeamSocket(
        { name: TEAM, tmuxTmpdir },
        { uid: process.getuid?.() ?? 0 },
      );
      expect(socketPath).toBe(`${tmuxTmpdir}/tmux-${process.getuid?.() ?? 0}/default`);

      // The abstraction's tmux namespace at that path can see the bare-session.
      const tmux = createCanonicalAtmuxTmux({ socketPath });
      const found = await tmux.session.hasSession(SESSION);
      expect(found).toBe(true);
    },
  );

  test.skipIf(!HAS_TMUX)(
    "Beat 2 ([down]→[up] repro): real tmux shows canonical fallback misses; resolveTeamSocket finds",
    async () => {
      // Same shape — real tmux bare session under custom TMUX_TMPDIR.
      const newSess = tmuxEnv(
        ["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"],
        tmuxTmpdir,
        homeDir,
      );
      expect(newSess.exitCode).toBe(0);

      // Pre-fix path: status used getDefaultSocket(team.name) →
      // /tmp/atmux-<team>/sock — which is NOT where this session lives.
      // hasSession returns false → status renders [down]. This is the
      // bug the dispatch describes.
      const canonicalSocket = getDefaultSocket(TEAM);
      expect(canonicalSocket).toBe(`/tmp/atmux-${TEAM}/sock`);
      const tmuxCanonical = createCanonicalAtmuxTmux({ socketPath: canonicalSocket });
      const foundCanonical = await tmuxCanonical.session.hasSession(SESSION);
      expect(foundCanonical).toBe(false); // [down] — false positive

      // Post-fix path: resolveTeamSocket honours team.tmuxTmpdir →
      // socket exists, hasSession returns true → status renders [up].
      const resolvedSocket = resolveTeamSocket(
        { name: TEAM, tmuxTmpdir },
        { uid: process.getuid?.() ?? 0 },
      );
      const tmuxResolved = createCanonicalAtmuxTmux({ socketPath: resolvedSocket });
      const foundResolved = await tmuxResolved.session.hasSession(SESSION);
      expect(foundResolved).toBe(true); // [up] — correct
    },
  );
});
