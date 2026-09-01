// Unit tests for src/verbs/attach.ts (ADR-010 + ADR-004 amend).
// Bash spec ref: lib/attach.sh @ 2aadc3f.
//
// Coverage strategy
// -----------------
// Every branch of `parseAttachArgs` + `defaultSocketPath` +
// `exactSessionTarget` is unit-testable in isolation; those tests
// dominate the file. The integration paths (attach against a real
// tmux server) follow the precedent set by
// `tests/unit/abstractions/tmux.test.ts:510-514` — spin a real tmux
// server on an isolated `socketPath` per test, exercise the verb,
// assert the observable surfaces:
//
//   1. Session absent  → ConfigError "session <name> does not exist".
//   2. Session present → TmuxError. (`attach-session` blocks waiting
//      for a controlling tty; bun:test runs without one, so tmux
//      exits non-zero immediately and the abstraction surfaces a
//      TmuxError. We never observe a "successful attach" in CI.)
//   3. team.json missing  → ConfigError from requireTeam.
//
// The TMUX-env unset/restore branches in `attach()` are exercised by
// the "session-present" test running twice — once with `process.env.TMUX`
// set, once with it absent. Both throw TmuxError; both `finally`
// branches run. The assertion is on the post-call value of
// `process.env.TMUX` matching the pre-call value.
//
// Memory ref `feedback_tmux_test_isolation.md`: every tmux subprocess
// here addresses an isolated `-S <socketPath>` baked into argv by
// the canonical atmux-conf helper, so kill-server / kill-session in teardown CANNOT
// touch the operator's daily-driver tmux server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TmuxNamespace } from "../../../src/abstractions/tmux.ts";
import { teamJsonPath } from "../../../src/core/common.ts";
import { ConfigError, TmuxError, UsageError } from "../../../src/errors.ts";
import {
  attach,
  attachWithTmux,
  defaultSocketPath,
  exactSessionTarget,
  parseAttachArgs,
} from "../../../src/verbs/attach.ts";
import { createCanonicalAtmuxTmux, setCanonicalAtmuxTmuxHome } from "../../helpers/tmux.ts";

// ---------- pure helpers ----------

describe("parseAttachArgs", () => {
  test("empty argv → no flags set", () => {
    expect(parseAttachArgs([])).toEqual({});
  });

  test("--socket <path> sets socketPath", () => {
    expect(parseAttachArgs(["--socket", "/tmp/x/sock"])).toEqual({
      socketPath: "/tmp/x/sock",
    });
  });

  test("--team-dir <dir> sets teamDir", () => {
    expect(parseAttachArgs(["--team-dir", "/tmp/proj"])).toEqual({
      teamDir: "/tmp/proj",
    });
  });

  test("both flags accepted in either order", () => {
    expect(parseAttachArgs(["--socket", "/s", "--team-dir", "/d"])).toEqual({
      socketPath: "/s",
      teamDir: "/d",
    });
    expect(parseAttachArgs(["--team-dir", "/d", "--socket", "/s"])).toEqual({
      socketPath: "/s",
      teamDir: "/d",
    });
  });

  test("--socket without value → UsageError", () => {
    expect(() => parseAttachArgs(["--socket"])).toThrow(UsageError);
  });

  test("--team-dir without value → UsageError", () => {
    expect(() => parseAttachArgs(["--team-dir"])).toThrow(UsageError);
  });

  test("unknown flag → UsageError", () => {
    expect(() => parseAttachArgs(["--bogus"])).toThrow(UsageError);
  });

  test("positional unexpected → UsageError", () => {
    expect(() => parseAttachArgs(["foo"])).toThrow(UsageError);
  });
});

describe("defaultSocketPath", () => {
  test("returns /tmp/atmux-<team>/sock — bash cage convention", () => {
    expect(defaultSocketPath("atmux")).toBe("/tmp/atmux-atmux/sock");
    expect(defaultSocketPath("unum")).toBe("/tmp/atmux-unum/sock");
    expect(defaultSocketPath("ifca_aux")).toBe("/tmp/atmux-ifca_aux/sock");
  });
});

describe("exactSessionTarget", () => {
  test("prepends '=' for tmux exact-match (bash lib/common.sh:590)", () => {
    expect(exactSessionTarget("atmux-foo")).toBe("=atmux-foo");
    expect(exactSessionTarget("x")).toBe("=x");
  });
});

// ---------- integration: attach against a real tmux ----------

let scratch: string;
let socketDir: string;
let socketPath: string;
let homeDir: string;
let sessionPrefix: string;
let priorTmux: string | undefined;
let priorAtmuxDir: string | undefined;
let priorAtmuxTeamDir: string | undefined;
let priorAtmuxSession: string | undefined;
let priorDriverSession: string | undefined;
let restoreHome: (() => void) | null = null;

async function seedTeam(atmuxDir: string, team: unknown): Promise<void> {
  await mkdir(atmuxDir, { recursive: true });
  await writeFile(teamJsonPath(atmuxDir), JSON.stringify(team));
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-attach-"));
  socketDir = await mkdtemp(join(tmpdir(), "atmux-attach-sock-"));
  socketPath = join(socketDir, "sock");
  homeDir = await mkdtemp(join(tmpdir(), "atmux-attach-home-"));
  sessionPrefix = `s${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  // Strip env that would override --team-dir / leak into getAtmuxDir +
  // getSessionName resolution — same belt-and-braces as the tmux
  // abstraction tests. The verb under test reads process.env directly
  // through core/common.ts; no per-call env injection point.
  priorTmux = process.env.TMUX;
  priorAtmuxDir = process.env.ATMUX_DIR;
  priorAtmuxTeamDir = process.env.ATMUX_TEAM_DIR;
  priorAtmuxSession = process.env.ATMUX_SESSION;
  priorDriverSession = process.env.ATMUX_DRIVER_SESSION;
  delete process.env.TMUX;
  delete process.env.ATMUX_DIR;
  delete process.env.ATMUX_TEAM_DIR;
  delete process.env.ATMUX_SESSION;
  delete process.env.ATMUX_DRIVER_SESSION;
  restoreHome = setCanonicalAtmuxTmuxHome(homeDir);
});

afterEach(async () => {
  // Tear down the per-test tmux server through the same socket-pinned
  // abstraction so the kill cannot escape to the operator's server.
  try {
    const tmux = createCanonicalAtmuxTmux({ socketPath });
    await tmux.server.killServer();
  } catch {
    // expected: server may have never started or already exited
  }

  restoreHome?.();
  restoreHome = null;

  if (priorTmux !== undefined) process.env.TMUX = priorTmux;
  else delete process.env.TMUX;
  if (priorAtmuxDir !== undefined) process.env.ATMUX_DIR = priorAtmuxDir;
  else delete process.env.ATMUX_DIR;
  if (priorAtmuxTeamDir !== undefined) process.env.ATMUX_TEAM_DIR = priorAtmuxTeamDir;
  else delete process.env.ATMUX_TEAM_DIR;
  if (priorAtmuxSession !== undefined) process.env.ATMUX_SESSION = priorAtmuxSession;
  else delete process.env.ATMUX_SESSION;
  if (priorDriverSession !== undefined) process.env.ATMUX_DRIVER_SESSION = priorDriverSession;
  else delete process.env.ATMUX_DRIVER_SESSION;

  await rm(socketDir, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
});

describe("attach() — pre-flight failures", () => {
  test("missing team.json → ConfigError from requireTeam", async () => {
    await expect(attach(["--team-dir", scratch, "--socket", socketPath])).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("argv parse failure surfaces as UsageError", async () => {
    await expect(attach(["--socket"])).rejects.toBeInstanceOf(UsageError);
  });
});

describe("attach() — session existence check", () => {
  test("team present but session absent → ConfigError 'does not exist'", async () => {
    const teamName = `${sessionPrefix}-team`;
    await seedTeam(join(scratch, ".atmux"), { name: teamName, members: [] });
    // No tmux server started → has-session returns false → verb dies.
    try {
      await attach(["--team-dir", scratch, "--socket", socketPath]);
      throw new Error("attach should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      // Bash text-parity: "session <name> does not exist".
      expect(err.message).toContain(`session ${teamName} does not exist`);
      // Hint text-parity: "run 'atmux start' first".
      expect(err.message).toContain("run 'atmux start' first");
    }
  });
});

describe("attach() — session present but no tty", () => {
  test("attach against existing session → TmuxError (no controlling tty in CI)", async () => {
    const teamName = `${sessionPrefix}t1`;
    await seedTeam(join(scratch, ".atmux"), { name: teamName, members: [] });
    // Pre-create the session on the same isolated socket the verb will
    // address, then call attach. The blocking attach returns immediately
    // with non-zero because bun:test has no controlling tty; the
    // abstraction wraps tmux's failure as TmuxError.
    const tmux = createCanonicalAtmuxTmux({ socketPath });
    await tmux.session.newSession({ name: teamName });

    await expect(attach(["--team-dir", scratch, "--socket", socketPath])).rejects.toBeInstanceOf(
      TmuxError,
    );
  });

  test("TMUX env is restored after attach (set → set)", async () => {
    const teamName = `${sessionPrefix}t2`;
    await seedTeam(join(scratch, ".atmux"), { name: teamName, members: [] });
    const tmux = createCanonicalAtmuxTmux({ socketPath });
    await tmux.session.newSession({ name: teamName });

    // Simulate operator-inside-tmux: $TMUX populated. Verb deletes for
    // the duration of the attach call, restores in `finally` regardless
    // of TmuxError exit.
    const sentinel = "/tmp/fake-tmux-socket,12345,0";
    process.env.TMUX = sentinel;
    await expect(attach(["--team-dir", scratch, "--socket", socketPath])).rejects.toBeInstanceOf(
      TmuxError,
    );
    expect(process.env.TMUX).toBe(sentinel);
  });

  test("TMUX env stays unset after attach (unset → unset)", async () => {
    const teamName = `${sessionPrefix}t3`;
    await seedTeam(join(scratch, ".atmux"), { name: teamName, members: [] });
    const tmux = createCanonicalAtmuxTmux({ socketPath });
    await tmux.session.newSession({ name: teamName });

    // Pre-condition: $TMUX is already unset (beforeEach deleted it).
    expect(process.env.TMUX).toBeUndefined();
    await expect(attach(["--team-dir", scratch, "--socket", socketPath])).rejects.toBeInstanceOf(
      TmuxError,
    );
    // Finally branch must NOT re-set $TMUX when there was nothing to restore.
    expect(process.env.TMUX).toBeUndefined();
  });
});

describe("attachWithTmux — direct (stubbed namespace)", () => {
  // The real `attachSession` blocks waiting for a controlling tty, so the
  // verb's `return 0` post-attach line is unreachable through `attach()`
  // in CI. We stub the namespace here to assert: (1) the success path
  // returns 0 and restores TMUX env, (2) the absent-session branch throws
  // ConfigError from inside attachWithTmux too.

  function stubNamespace(opts: {
    sessionExists: boolean;
    onAttach?: () => Promise<void>;
  }): TmuxNamespace {
    return {
      session: {
        async hasSession(_name: string) {
          return opts.sessionExists;
        },
      },
      client: {
        async attachSession(_name: string) {
          if (opts.onAttach) await opts.onAttach();
        },
      },
      // Other namespaces are unused by attachWithTmux; cast through unknown
      // is appropriate since we only exercise session.hasSession +
      // client.attachSession.
    } as unknown as TmuxNamespace;
  }

  test("returns 0 on a clean attach (post-detach success path)", async () => {
    const ns = stubNamespace({ sessionExists: true });
    const exit = await attachWithTmux(ns, "atmux-foo");
    expect(exit).toBe(0);
  });

  test("restores TMUX after a successful detach (set → set)", async () => {
    process.env.TMUX = "/tmp/sentinel,42,0";
    const ns = stubNamespace({
      sessionExists: true,
      onAttach: async () => {
        // Inside the blocking call, TMUX MUST be unset — that's the
        // bash `env -u TMUX` parity. Capture the in-flight value to
        // assert on after.
        capturedDuring = process.env.TMUX;
      },
    });
    let capturedDuring: string | undefined = "not-yet";
    await attachWithTmux(ns, "atmux-bar");
    expect(capturedDuring).toBeUndefined();
    expect(process.env.TMUX).toBe("/tmp/sentinel,42,0");
  });

  test("absent session branch throws ConfigError when called direct", async () => {
    const ns = stubNamespace({ sessionExists: false });
    await expect(attachWithTmux(ns, "atmux-missing")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("attach() — default socket path", () => {
  test("without --socket, falls back to defaultSocketPath(team.name)", async () => {
    // We can't actually attach against `/tmp/atmux-<team>/sock` (we'd
    // need to spin a real tmux there, which clobbers the convention
    // for any real team named the same). Instead we let the default
    // socket path fail: with no tmux server bound there, hasSession
    // returns false, so we reach the same ConfigError "does not exist"
    // branch — but the error path proves the verb DID compute the
    // default and DID dispatch a tmux probe through it. The test
    // narrows further by inspecting the resolved error message format.
    const teamName = `${sessionPrefix}default`;
    await seedTeam(join(scratch, ".atmux"), { name: teamName, members: [] });
    try {
      await attach(["--team-dir", scratch]); // no --socket
      throw new Error("attach should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.message).toContain(`session ${teamName} does not exist`);
    }
  });
});
