// ADR-305 — the createTmux connect-time socket guard.
//
// Every spawn path of a TmuxNamespace (the shared tmuxRunRaw, loadBuffer's
// stdin path, attachSessionInheritStdio's tty path) must run the guard
// BEFORE tmux is exec'ed, and a refusal must surface as the guard's own
// ConfigError — never be swallowed into a TmuxError or a "no server".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTmux,
  defaultSocketGuard,
  type SocketConfig,
} from "../../../src/abstractions/tmux.ts";
import { UnsafeSocketPathError } from "../../../src/core/socket-dir.ts";
import { getAtmuxTmuxConfPath } from "../../../src/core/tmux-paths.ts";
import { ConfigError, TmuxError } from "../../../src/errors.ts";

const uid = process.getuid?.() ?? 0;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "atmux-tmux-guard-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function sharedDir(name: string, mode = 0o755): string {
  const d = join(scratch, name);
  mkdirSync(d);
  chmodSync(d, mode);
  return d;
}

describe("createTmux — guard runs before every spawn path", () => {
  test("hasSession: guard sees the config; a refusal propagates as-is", async () => {
    const seen: SocketConfig[] = [];
    const refusal = new ConfigError({ what: "refused by test guard" });
    const tmux = createTmux({
      socketPath: join(scratch, "x", "sock"),
      configFile: getAtmuxTmuxConfPath(),
      hooks: {
        socketGuard: (cfg) => {
          seen.push(cfg);
          throw refusal;
        },
      },
    });
    await expect(tmux.session.hasSession("=nope")).rejects.toBe(refusal);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.socketPath).toBe(join(scratch, "x", "sock"));
  });

  test("loadBuffer: guard refusal stops the stdin spawn", async () => {
    const refusal = new ConfigError({ what: "refused" });
    const tmux = createTmux({
      socketPath: join(scratch, "x", "sock"),
      configFile: getAtmuxTmuxConfPath(),
      hooks: {
        socketGuard: () => {
          throw refusal;
        },
      },
    });
    await expect(tmux.buffer.loadBuffer({ data: "hi" })).rejects.toBe(refusal);
  });

  test("attachSessionInheritStdio: guard refusal means tmux is never exec'ed", async () => {
    let spawned = 0;
    const refusal = new ConfigError({ what: "refused" });
    const tmux = createTmux({
      socketPath: join(scratch, "x", "sock"),
      configFile: getAtmuxTmuxConfPath(),
      hooks: {
        socketGuard: () => {
          throw refusal;
        },
        spawnInheritStdio: async () => {
          spawned += 1;
          return 0;
        },
      },
    });
    await expect(tmux.client.attachSessionInheritStdio("=x")).rejects.toBe(refusal);
    expect(spawned).toBe(0);
  });

  test("attachSessionInheritStdio: a passing guard lets the spawn run", async () => {
    let guarded = 0;
    let spawned = 0;
    const tmux = createTmux({
      socketPath: join(scratch, "x", "sock"),
      configFile: getAtmuxTmuxConfPath(),
      hooks: {
        socketGuard: () => {
          guarded += 1;
        },
        spawnInheritStdio: async () => {
          spawned += 1;
          return 0;
        },
      },
    });
    await tmux.client.attachSessionInheritStdio("=x");
    expect([guarded, spawned]).toEqual([1, 1]);
  });

  test("default guard wired: a shared (0755) socket dir is refused, not reported as 'no server'", async () => {
    const d = sharedDir("shared");
    const tmux = createTmux({ socketPath: join(d, "sock"), configFile: getAtmuxTmuxConfPath() });
    const p = tmux.session.hasSession("=nope");
    await expect(p).rejects.toBeInstanceOf(UnsafeSocketPathError);
    await expect(tmux.session.hasSession("=nope")).rejects.not.toBeInstanceOf(TmuxError);
    await expect(tmux.buffer.loadBuffer({ data: "x" })).rejects.toBeInstanceOf(
      UnsafeSocketPathError,
    );
  });

  test("default guard wired: a private (0700) dir with no server reads as 'no session'", async () => {
    const d = join(scratch, "private");
    mkdirSync(d, { mode: 0o700 });
    const tmux = createTmux({ socketPath: join(d, "sock"), configFile: getAtmuxTmuxConfPath() });
    expect(await tmux.session.hasSession("=nope")).toBe(false);
  });
});

describe("defaultSocketGuard", () => {
  test("-S: shared dir refused with the chmod hint; private dir passes; absent dir passes", () => {
    const shared = sharedDir("s", 0o777);
    expect(() => defaultSocketGuard({ socketPath: join(shared, "sock") })).toThrow(
      `chmod 700 ${shared}`,
    );
    const priv = join(scratch, "p");
    mkdirSync(priv, { mode: 0o700 });
    expect(() => defaultSocketGuard({ socketPath: join(priv, "sock") })).not.toThrow();
    expect(() => defaultSocketGuard({ socketPath: join(scratch, "absent", "sock") })).not.toThrow();
  });

  test("-S: a directory that is ours reads as foreign to another uid", () => {
    const priv = join(scratch, "p");
    mkdirSync(priv, { mode: 0o700 });
    expect(() => defaultSocketGuard({ socketPath: join(priv, "sock") }, {}, uid + 4242)).toThrow(
      /owned by uid \d+, not uid/,
    );
  });

  test("-L: checks $TMUX_TMPDIR/tmux-<uid> — group bits refused (tmux itself only rejects world bits)", () => {
    sharedDir(`tmux-${uid}`, 0o750);
    expect(() => defaultSocketGuard({ socket: "atmux-cockpit" }, { TMUX_TMPDIR: scratch })).toThrow(
      `${join(scratch, `tmux-${uid}`)} has mode 0750`,
    );
  });

  test("-L: private or absent tmux-<uid> passes", () => {
    const env = { TMUX_TMPDIR: scratch };
    expect(() => defaultSocketGuard({ socket: "atmux-cockpit" }, env)).not.toThrow();
    mkdirSync(join(scratch, `tmux-${uid}`), { mode: 0o700 });
    expect(() => defaultSocketGuard({ socket: "atmux-cockpit" }, env)).not.toThrow();
  });

  test("-L: empty / unset TMUX_TMPDIR resolves under /tmp", async () => {
    // A ghost uid whose /tmp/tmux-<ghost> this test plants (owned by US,
    // so foreign to the ghost): refused only if /tmp is the base consulted.
    const ghost = 2_000_000_000 + (process.pid % 100_000);
    const planted = `/tmp/tmux-${ghost}`;
    mkdirSync(planted, { mode: 0o700 });
    try {
      expect(() =>
        defaultSocketGuard({ socket: "atmux-cockpit" }, { TMUX_TMPDIR: "" }, ghost),
      ).toThrow(`${planted} is owned by uid`);
      expect(() => defaultSocketGuard({ socket: "atmux-cockpit" }, {}, ghost)).toThrow(
        UnsafeSocketPathError,
      );
      // …and a non-empty TMUX_TMPDIR moves the lookup away from /tmp.
      expect(() =>
        defaultSocketGuard({ socket: "atmux-cockpit" }, { TMUX_TMPDIR: scratch }, ghost),
      ).not.toThrow();
    } finally {
      await rm(planted, { recursive: true, force: true });
    }
  });

  test("no POSIX uid → -L is not checked", () => {
    sharedDir(`tmux-${uid}`, 0o777);
    expect(() => defaultSocketGuard({ socket: "x" }, { TMUX_TMPDIR: scratch }, null)).not.toThrow();
  });
});
